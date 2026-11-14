#!/usr/bin/env bash
# Real root inode/key/pin checks in an owned, disposable, read-only Linux image.
set -euo pipefail
base_image=${1:?Pass the locally verified supervisor image digest}
[[ "$base_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
task_root=$(mktemp -d "${TMPDIR:-/tmp}/lyrashield-sandbox-key.XXXXXX")
task_base_tag="lyrashield-sandbox-key-smoke:base-${task_root##*.}"
task_positive_tag="lyrashield-sandbox-key-smoke:positive-${task_root##*.}"
cleanup() {
  for file in "$task_root"/*.iid; do
    [[ -f "$file" ]] || continue
    image_id=$(cat "$file")
    [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] && docker image rm "$image_id" >/dev/null 2>&1 || true
  done
  docker image rm "$task_base_tag" >/dev/null 2>&1 || true
  rm -rf "$task_root"
}
trap cleanup EXIT
docker tag "$base_image" "$task_base_tag"
boot_id=$(docker run --rm --network none --read-only --user 0 --entrypoint cat "$base_image" /proc/sys/kernel/random/boot_id)
node --input-type=module - "$task_root" "$boot_id" <<'JS'
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
const [dir,bootId]=process.argv.slice(2), now=Math.floor(Date.now()/1000);
const keys=generateKeyPairSync('rsa',{modulusLength:3072});
const canonical=value=>JSON.stringify(value,(key,val)=>val&&typeof val==='object'&&!Array.isArray(val)?Object.fromEntries(Object.entries(val).sort(([a],[b])=>a.localeCompare(b))):val);
const source='a'.repeat(40), digest='sha256:'+'b'.repeat(64), owner='1:1', nonce='c'.repeat(64);
const policy=canonical({components:{supervisor:{environment:{TOOL_URL:'http://lyrashield-supervisor:9191'}}}});
const record={schema:'lyrashield-disposable-native-authority/1',purpose:'disposable-linux-native-tests',epochId:'disposable-'+'d'.repeat(32),epoch:1,owner,bootId,nonce,sourceTree:source,issuedAt:now-1,expiresAt:now+300,productRevision:source,engineRevision:source,workerDigest:digest,sandboxDigest:digest,brokerDigest:digest,supervisorDigest:digest,providerGatewayDigest:digest,migrationChecksum:digest,runtimePolicyDigest:'sha256:'+createHash('sha256').update(policy).digest('hex'),dependencies:Object.fromEntries(['database','redis','provider'].map(role=>[role,{name:'lyrashield-fixture-'+role+'-'+'e'.repeat(16),image:'fixture/'+role+'@'+digest}]))};
const raw=canonical(record),keyId='disposable-key-'+nonce.slice(0,16);
const files={
 'disposable-native-authority.json':canonical({raw,result:{algorithm:'RS256',keyId,signature:sign('RSA-SHA256',Buffer.from(raw),keys.privateKey).toString('base64')}}),
 'disposable-native-context.json':canonical({schema:'lyrashield-disposable-native-context/1',owner,bootId,nonce,sourceRevision:source,sourceTree:source}),
 'disposable-native-pin.json':canonical({purpose:record.purpose,algorithm:'RS256',keyId,publicKey:keys.publicKey.export({format:'jwk'})}),
 'disposable-runtime-policy.json':policy,
 'disposable-sandbox-grant-key.pem':keys.privateKey.export({format:'pem',type:'pkcs8'})
};
mkdirSync(dir+'/fixture');
for(const [name,bytes]of Object.entries(files))writeFileSync(dir+'/fixture/'+name,bytes,{mode:0o600});
JS
for name in root-sandbox-grant.ts root-sandbox-grant-native.ts root-disposable-sandbox-grant.ts sandbox-tool-capability.ts; do
  cp "apps/supervisor/src/$name" "$task_root/$name"
done
cat > "$task_root/smoke.ts" <<'JS'
import assert from 'node:assert/strict';
import {loadDisposableSandboxGrantSigningKey} from './root-disposable-sandbox-grant';
import {RootSandboxGrantSigner} from './root-sandbox-grant';
const scope=loadDisposableSandboxGrantSigningKey('a'.repeat(40));
assert.equal(scope.authority.purpose,'disposable-linux-native-tests');
assert.throws(()=>loadDisposableSandboxGrantSigningKey('f'.repeat(40)));
assert.throws(()=>RootSandboxGrantSigner.load('a'.repeat(40)));
console.log('PASS: real root held key, RSA pin and finite disposable scope');
JS
cat > "$task_root/Dockerfile" <<EOF_DOCKER
FROM $task_base_tag
USER root
COPY --chown=root:root --chmod=0400 fixture/ /opt/lyrashield/control/
COPY --chown=root:root --chmod=0400 fixture/ /fixture-seed/
RUN chmod 0755 /opt/lyrashield && chmod 0700 /opt/lyrashield/control
RUN chmod 0700 /fixture-seed
COPY --chown=root:root --chmod=0444 *.ts /app/src/
WORKDIR /app
ENTRYPOINT ["node","--import","tsx","/app/src/smoke.ts"]
EOF_DOCKER
docker build --network none --quiet --tag "$task_positive_tag" --iidfile "$task_root/positive.iid" "$task_root" >/dev/null
positive_image=$(cat "$task_root/positive.iid")
docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges --user 0 "$positive_image"
if docker run --rm --read-only --network none --cap-drop ALL --user 65534 "$positive_image" >/dev/null 2>&1; then
  echo 'FAIL: nonroot loaded signing key' >&2; exit 1
fi
cat > "$task_root/Dockerfile.bad-mode" <<EOF_DOCKER
FROM $task_positive_tag
USER root
RUN chmod 0444 /opt/lyrashield/control/disposable-sandbox-grant-key.pem
EOF_DOCKER
docker build --network none --quiet -f "$task_root/Dockerfile.bad-mode" --iidfile "$task_root/mode.iid" "$task_root" >/dev/null
if docker run --rm --read-only --network none --cap-drop ALL --user 0 "$(cat "$task_root/mode.iid")" >/dev/null 2>&1; then
  echo 'FAIL: nonprivate key was accepted' >&2; exit 1
fi
docker run --rm --read-only --network none --cap-drop ALL --user 0 \
  --tmpfs /opt/lyrashield/control:rw,mode=0700 --entrypoint /bin/sh "$positive_image" -c '
    cp -a /fixture-seed/. /opt/lyrashield/control/
    ln /opt/lyrashield/control/disposable-sandbox-grant-key.pem /opt/lyrashield/control/reused-key.pem
    test "$(stat -c %h /opt/lyrashield/control/disposable-sandbox-grant-key.pem)" = 2
    node --import tsx --input-type=module -e '\''
      import assert from "node:assert/strict";
      import {loadDisposableSandboxGrantSigningKey} from "/app/src/root-disposable-sandbox-grant.ts";
      assert.throws(()=>loadDisposableSandboxGrantSigningKey("a".repeat(40)), {message:"Root sandbox grant authority unavailable"});
    '\''
  '
echo 'PASS: nonroot, nonprivate and reused-key cases denied; owned images cleaned'
