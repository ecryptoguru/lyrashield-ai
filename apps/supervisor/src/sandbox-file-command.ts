import { z } from "zod"
import { createHash } from "node:crypto"
import { sandboxToolResponseBindingSchema } from "./sandbox-tool-response"

export const SANDBOX_FILE_INPUT_BYTES = 64 * 1024
export const SANDBOX_FILE_OUTPUT_BYTES = 512 * 1024
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/workspace/") &&
      !value.includes("\0") &&
      value
        .split("/")
        .slice(2)
        .every((part) => part !== "" && part !== "." && part !== "..")
  )
const base = {
  binding: sandboxToolResponseBindingSchema,
  requestId: z.string().uuid(),
  commandId: z.string().uuid(),
}
const encoded = z
  .string()
  .max(Math.ceil(SANDBOX_FILE_INPUT_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const sandboxFileOperationSchemas = {
  "files/read": z
    .object({
      ...base,
      path,
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
    })
    .strict(),
  "files/write": z.object({ ...base, path, dataBase64: encoded, sha256: hash }).strict(),
  "workspace/persist": z
    .object({
      ...base,
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
    })
    .strict(),
  "workspace/hydrate": z.object({ ...base, archiveBase64: encoded, sha256: hash }).strict(),
}
export type SandboxFileKind = keyof typeof sandboxFileOperationSchemas

// Fixed code executes only as the sandbox user. Every component opens relative
// to an owned /workspace descriptor with O_NOFOLLOW; archive metadata is never extracted directly.
export const SANDBOX_FILE_PROGRAM = String.raw`import base64,hashlib,io,json,os,stat,sys,tarfile
LIMIT=524288
payload=json.loads(base64.b64decode(''.join(sys.argv[1:]),validate=True))
kind=payload.pop('kind')
root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
def parent(path,create=False):
 parts=path.split('/')
 if parts[:2]!=['','workspace'] or any(p in ('','.','..') for p in parts[2:]): raise ValueError('path')
 fd=os.dup(root)
 try:
  for part in parts[2:-1]:
   if create:
    try: os.mkdir(part,0o750,dir_fd=fd)
    except FileExistsError: pass
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=nxt
  return fd,parts[-1]
 except BaseException:
  os.close(fd);raise
def read(path,maximum):
 fd,name=parent(path)
 try:
  f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  try:
   if not stat.S_ISREG(os.fstat(f).st_mode): raise ValueError('regular file required')
   with os.fdopen(f,'rb',closefd=False) as stream: data=stream.read(maximum+1)
   if len(data)>maximum: raise ValueError('incomplete capped file')
   return data
  finally: os.close(f)
 finally: os.close(fd)
def write(path,data):
 fd,name=parent(path,True)
 try:
  f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o640,dir_fd=fd)
  try:
   if not stat.S_ISREG(os.fstat(f).st_mode): raise ValueError('regular file required')
   os.ftruncate(f,0)
   with os.fdopen(f,'wb',closefd=False) as stream: stream.write(data);stream.flush();os.fsync(f)
  finally: os.close(f)
 finally: os.close(fd)
def digest(data): return hashlib.sha256(data).hexdigest()
def input_data(field):
 data=base64.b64decode(payload[field],validate=True)
 if len(data)>65536 or digest(data)!=payload['sha256']: raise ValueError('input checksum or bound')
 return data
if kind=='files/read':
 data=read(payload['path'],min(payload['maxBytes'],LIMIT))
 result={'dataBase64':base64.b64encode(data).decode(),'sha256':digest(data)}
elif kind=='files/write':
 data=input_data('dataBase64');write(payload['path'],data);result={'sha256':digest(data)}
elif kind=='workspace/persist':
 output=io.BytesIO();total=0;count=0
 def walk(fd,prefix,archive):
  global total,count
  for name in sorted(os.listdir(fd)):
   count+=1
   if count>1000: raise ValueError('incomplete capped archive')
   info=os.stat(name,dir_fd=fd,follow_symlinks=False);relative=prefix+name
   if stat.S_ISDIR(info.st_mode):
    entry=tarfile.TarInfo(relative+'/');entry.type=tarfile.DIRTYPE;entry.mode=0o750;archive.addfile(entry)
    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    try: walk(child,relative+'/',archive)
    finally: os.close(child)
   elif stat.S_ISREG(info.st_mode):
    data=read('/workspace/'+relative,LIMIT-total);total+=len(data)
    entry=tarfile.TarInfo(relative);entry.size=len(data);entry.mode=0o640
    archive.addfile(entry,io.BytesIO(data))
   else: raise ValueError('incomplete unreadable archive member')
   if output.tell()>LIMIT: raise ValueError('incomplete capped archive')
 with tarfile.open(fileobj=output,mode='w') as archive: walk(root,'',archive)
 data=output.getvalue()
 if len(data)>min(payload['maxBytes'],LIMIT): raise ValueError('incomplete capped archive')
 result={'archiveBase64':base64.b64encode(data).decode(),'sha256':digest(data)}
elif kind=='workspace/hydrate':
 data=input_data('archiveBase64');members=[];total=0
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as archive:
  for entry in archive:
   if len(members)>=1000 or not (entry.isfile() or entry.isdir()) or entry.name.startswith('/') or any(p in ('','.','..') for p in entry.name.rstrip('/').split('/')): raise ValueError('unsafe archive')
   total+=entry.size
   if total>LIMIT or entry.size<0: raise ValueError('incomplete capped archive')
   content=b''
   if entry.isfile():
    stream=archive.extractfile(entry)
    if stream is None: raise ValueError('unreadable archive')
    content=stream.read(entry.size+1)
    if len(content)!=entry.size: raise ValueError('unreadable archive')
   members.append((entry.name.rstrip('/'),entry.isdir(),content))
 for name,directory,content in members:
  if directory:
   fd,leaf=parent('/workspace/'+name,True)
   try:
    try: os.mkdir(leaf,0o750,dir_fd=fd)
    except FileExistsError:
     child=os.open(leaf,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(child)
   finally: os.close(fd)
  else: write('/workspace/'+name,content)
 result={'sha256':digest(data)}
else: raise ValueError('operation')
os.close(root)
print(json.dumps(result,separators=(',',':')))
`

export function sandboxFileCommand(kind: SandboxFileKind, input: unknown) {
  const request = sandboxFileOperationSchemas[kind].parse(input)
  const payload = { ...request, kind }
  for (const field of ["dataBase64", "archiveBase64"] as const) {
    if (field in request) {
      const value = Reflect.get(request, field) as string
      const bytes = Buffer.from(value, "base64")
      if (
        bytes.byteLength > SANDBOX_FILE_INPUT_BYTES ||
        bytes.toString("base64") !== value ||
        createHash("sha256").update(bytes).digest("hex") !== Reflect.get(request, "sha256")
      )
        throw new Error("Sandbox file input is capped")
    }
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64")
  const chunks = encoded.match(/.{1,4096}/g)!
  return { request, argv: ["python3", "-c", SANDBOX_FILE_PROGRAM, ...chunks] }
}
