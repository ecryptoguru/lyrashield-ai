#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import {
  canonicalJson,
  sha256Hex,
  R2ConditionalObjectStore,
  PostgresAuthorityMirror,
  StoredJournalSealEvidenceReader,
  JournalSealPublisher,
  JournalSealPendingError,
  createInstalledJournalSealPinStore,
  readInstalledJournalSealControlPolicy,
  createPgConnectionConfig,
  loadSupervisorConfig,
  loadDatabaseSupervisorAuthority,
  loadInstalledSupervisorJournal,
  supervisorJournalEventSchema,
  S3Client,
  Pool,
  publisherDeployed,
  deriveSupervisorToolJournalIdentity,
  sandboxToolEventSchema,
} from "./publisher-runtime.mjs"
import {
  readRootPublicationBytes,
  parseRootPublicationConfiguration,
  RootJournalSealPublicationFence,
  createPublicationRecoverySnapshot,
  observePublishedJournal,
} from "./journal-seal-publication.mjs"

function check(value) {
  if (!value) throw new Error("Root journal seal publication is unavailable")
}

function objectStore(raw, schema, policy) {
  const config = JSON.parse(raw)
  check(
    config &&
      Object.keys(config).sort().join(",") ===
        "accessKeyId,accountId,bucket,schema,secretAccessKey" &&
      config.schema === schema &&
      /^[a-f0-9]{32}$/.test(config.accountId) &&
      /^[a-f0-9]{32}$/.test(config.accessKeyId) &&
      /^[a-f0-9]{64}$/.test(config.secretAccessKey) &&
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
  )
  if (policy)
    check(
      config.accountId === policy.controlAccountId &&
        config.bucket === policy.controlBucket &&
        config.accessKeyId === policy.controlCredentialId
    )
  const client = new S3Client({
    region: "auto",
    maxAttempts: 1,
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  return {
    store: new R2ConditionalObjectStore(client, config.bucket, 1024 * 1024, 5000),
    close: () => client.destroy(),
    config,
  }
}

async function assertSealMirrorRole(pool, expectedRole) {
  const proof = await pool.query(
    `SELECT current_user=$1 AND session_user=$1 AND r.rolcanlogin
    AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
    AND has_schema_privilege(current_user,'lyrashield_authority','USAGE')
    AND has_function_privilege(current_user,'lyrashield_authority.read_head(text,text)','EXECUTE')
    AND has_function_privilege(current_user,'lyrashield_authority.read_seal_head(text,text)','EXECUTE')
    AND has_function_privilege(current_user,'lyrashield_authority.read_seal(text,text,bigint)','EXECUTE')
    AND has_function_privilege(current_user,'lyrashield_authority.append_seal(text,text,text,text,text)','EXECUTE')
    AND NOT has_function_privilege(current_user,'lyrashield_authority.append_record(text,text,text,text,text)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_roles reachable WHERE pg_has_role(current_user,reachable.oid,'SET')
      AND (reachable.rolsuper OR reachable.rolbypassrls OR reachable.rolcreaterole OR reachable.rolcreatedb
        OR reachable.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_read_all_data','pg_write_all_data','pg_checkpoint','pg_maintain')
        OR has_database_privilege(reachable.oid,current_database(),'CREATE')
        OR has_database_privilege(reachable.oid,current_database(),'TEMPORARY')
        OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND has_schema_privilege(reachable.oid,n.oid,'CREATE'))
        OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','lyrashield_authority') AND c.relkind IN ('r','p','v','m','f')
            AND has_table_privilege(reachable.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,MAINTAIN'))
        OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','lyrashield_authority') AND c.relkind IN ('r','p','v','m','f')
            AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(reachable.oid,c.oid,a.attnum,'UPDATE'))
        OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND has_function_privilege(reachable.oid,p.oid,'EXECUTE')
            AND p.oid NOT IN ('lyrashield_authority.read_head(text,text)'::regprocedure,
              'lyrashield_authority.read_seal_head(text,text)'::regprocedure,
              'lyrashield_authority.read_seal(text,text,bigint)'::regprocedure,
              'lyrashield_authority.append_seal(text,text,text,text,text)'::regprocedure)))) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`,
    [expectedRole]
  )
  check(proof.rows.length === 1 && proof.rows[0]?.safe === true)
}

/** Fixed installed root configuration, genuine remote stores, original pending selector only. */
export async function publishInstalledJournalSeal({
  source,
  resumeSealHash,
  streamKind = "controller",
}) {
  check(streamKind === "controller" || streamKind === "tools")
  const filePrefix = streamKind === "tools" ? "tool-journal" : "journal"
  const configurationPath = `/etc/lyrashield/control/${filePrefix}-seal-publisher.json`
  const checkpointPath = `/etc/lyrashield/control/${filePrefix}-seal-checkpoint-key.txt`
  const storagePath = `/etc/lyrashield/control/${filePrefix}-seal-control-storage.json`
  check(
    publisherDeployed &&
      process.platform === "linux" &&
      process.getuid?.() === 0 &&
      /^[a-f0-9]{40}$/.test(source) &&
      (resumeSealHash === undefined || /^[a-f0-9]{64}$/.test(resumeSealHash))
  )
  const configBytes = readRootPublicationBytes(configurationPath)
  const config = parseRootPublicationConfiguration(configBytes, source)
  const policy = readInstalledJournalSealControlPolicy(source, streamKind),
    env = config.environment
  const mainIdentity = JSON.parse(env.LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON)
  const identity =
    streamKind === "tools"
      ? deriveSupervisorToolJournalIdentity({
          streamId: mainIdentity.streamId,
          authorityEpochId: env.LYRASHIELD_AUTHORITY_EPOCH_ID,
          supervisorInstanceId: env.LYRASHIELD_SUPERVISOR_INSTANCE_ID,
          originalSigningSecret: env.LYRASHIELD_SUPERVISOR_SIGNING_SECRET,
          wrapperSigningSecret: env.LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET,
        })
      : {
          originalSigningSecret: env.LYRASHIELD_SUPERVISOR_SIGNING_SECRET,
          wrapperSigningSecret: env.LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET,
          supervisorInstanceId: env.LYRASHIELD_SUPERVISOR_INSTANCE_ID,
          streamId: mainIdentity.streamId,
        }
  check(
    env.LYRASHIELD_AUTHORITY_EPOCH_ID === policy.epochId &&
      identity.supervisorInstanceId === policy.supervisorInstanceId &&
      identity.streamId === policy.streamId &&
      env.LYRASHIELD_RUNTIME_POLICY_DIGEST === policy.runtimePolicyDigest &&
      sha256Hex(identity.originalSigningSecret) === policy.originalKeyHash &&
      sha256Hex(identity.wrapperSigningSecret) === policy.wrapperKeyHash
  )
  const sealRole = decodeURIComponent(new URL(config.sealDatabaseUrl).username)
  check(sealRole === policy.databaseRole)
  const checkpoint = new TextDecoder("utf-8", { fatal: true }).decode(
    readRootPublicationBytes(checkpointPath)
  )
  check(Buffer.byteLength(checkpoint) >= 32 && sha256Hex(checkpoint) === policy.checkpointKeyHash)
  if (streamKind === "tools")
    check(
      policy.checkpointKeyHash !== policy.originalKeyHash &&
        policy.checkpointKeyHash !== policy.wrapperKeyHash
    )
  const closers = []
  let publishedSealHash
  try {
    const epochs = new Pool({
      ...createPgConnectionConfig(config.sealDatabaseUrl),
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    })
    closers.push(() => epochs.end())
    const mirrorPool = new Pool({
      ...createPgConnectionConfig(config.mirrorDatabaseUrl),
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    })
    closers.push(() => mirrorPool.end())
    await assertSealMirrorRole(
      mirrorPool,
      decodeURIComponent(new URL(config.mirrorDatabaseUrl).username)
    )
    const journalStorage = objectStore(
      env.LYRASHIELD_SUPERVISOR_JOURNAL_STORAGE_JSON,
      "lyrashield-supervisor-r2-journal-storage/1"
    )
    closers.push(journalStorage.close)
    const controlStorage = objectStore(
      readRootPublicationBytes(storagePath).toString("utf8"),
      "lyrashield-root-control-r2-storage/1",
      policy
    )
    closers.push(controlStorage.close)
    check(
      journalStorage.config.bucket !== controlStorage.config.bucket ||
        journalStorage.config.accountId !== controlStorage.config.accountId
    )
    check(journalStorage.config.accessKeyId !== controlStorage.config.accessKeyId)
    const supervisorConfig = loadSupervisorConfig(env),
      authority = loadDatabaseSupervisorAuthority(supervisorConfig, env)
    check(authority)
    closers.push(() => authority.close())
    const installed = await loadInstalledSupervisorJournal(supervisorConfig, authority, env, {
      purpose: "publication",
    })
    check(installed)
    closers.push(installed.close)
    const journal =
      streamKind === "tools" ? (await installed.createTools()).toolJournal : installed.journal
    const stream = { epochId: policy.epochId, supervisorInstanceId: policy.supervisorInstanceId }
    const mirror = new PostgresAuthorityMirror(
      mirrorPool,
      stream.epochId,
      stream.supervisorInstanceId
    )
    const common = {
      ...stream,
      store: journalStorage.store,
      mirror,
      originalSigningSecret: identity.originalSigningSecret,
      wrapperSigningSecret: identity.wrapperSigningSecret,
      headSigningSecret: identity.wrapperSigningSecret,
      sealSigningSecret: checkpoint,
      validateOriginal: (value) =>
        (streamKind === "tools" ? sandboxToolEventSchema : supervisorJournalEventSchema).parse(
          value
        ),
    }
    const evidence = new StoredJournalSealEvidenceReader(common)
    const pin = createInstalledJournalSealPinStore(source, evidence, epochs, streamKind)
    closers.push(pin.close)
    const fence = new RootJournalSealPublicationFence(epochs, source, streamKind)
    return await fence.run((assertActive) =>
      journal.withPublication(async (publication) => {
        const publisher = new JournalSealPublisher({
          ...common,
          ...publication,
          pin: pin.store,
          // Retain the real native root lease across the entire immutable publication and observation.
          fence: {
            run: async (operation) => {
              assertActive()
              const result = await operation(assertActive)
              assertActive()
              return result
            },
          },
          recoverySnapshot: {
            create: (input) =>
              createPublicationRecoverySnapshot(publication, input, assertActive, streamKind),
          },
        })
        const head = (await publication.original.load()).at(-1)
        check(head)
        // The library must resolve a pending control ACK using the retained original selector.
        const currentPin = resumeSealHash ? undefined : await pin.store.readCurrent(stream)
        const selector =
          resumeSealHash ??
          (currentPin?.lastSequence === head.sequence ? currentPin.sealHash : undefined)
        let seal = await publisher.publishNext({
          ...(selector ? { resumeSealHash: selector } : {}),
        })
        publishedSealHash = seal.sealHash
        while (seal && seal.lastSequence < head.sequence) {
          assertActive()
          seal = await publisher.publishNext()
          publishedSealHash = seal.sealHash
        }
        const observed = await observePublishedJournal({
          pin: pin.store,
          evidence,
          controlStore: controlStorage.store,
          store: journalStorage.store,
          mirror,
          stream,
        })
        check(
          observed.sequence === head.sequence &&
            configBytes.equals(readRootPublicationBytes(configurationPath))
        )
        assertActive()
        return {
          schema:
            streamKind === "tools"
              ? "lyrashield-root-tool-journal-seal-publication/1"
              : "lyrashield-root-journal-seal-publication/1",
          source,
          ...observed,
        }
      })
    )
  } catch (error) {
    if (error instanceof JournalSealPendingError || !publishedSealHash) throw error
    throw new JournalSealPendingError(publishedSealHash, error)
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close()
      } catch {
        /* publication facts remain immutable */
      }
    }
  }
}

/** Separate fixed root pin, checkpoint and control namespace for the derived tool stream. */
export function publishInstalledToolJournalSeal(input) {
  check(input && Object.keys(input).every((key) => key === "source" || key === "resumeSealHash"))
  return publishInstalledJournalSeal({ ...input, streamKind: "tools" })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tools = process.argv[3] === "--tools"
    check(
      tools
        ? process.argv.length === 4 || process.argv.length === 5
        : process.argv.length === 3 || process.argv.length === 4
    )
    const result = await publishInstalledJournalSeal({
      source: process.argv[2],
      streamKind: tools ? "tools" : "controller",
      resumeSealHash: process.argv[tools ? 4 : 3],
    })
    process.stdout.write(canonicalJson(result) + "\n")
  } catch (error) {
    // Retain and return the actual pending selector; never replace a failed receipt with success.
    process.stderr.write(
      canonicalJson({
        status: "UNKNOWN",
        ...(error instanceof JournalSealPendingError ? { sealHash: error.sealHash } : {}),
      }) + "\n"
    )
    process.exitCode = 1
  }
}
