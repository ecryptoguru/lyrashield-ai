import { describe, expect, it } from "vitest"
import { analyzePhpSource, PHP_SOURCE_RULE_VERSION } from "./php-source"

const scan = (body: string) => analyzePhpSource(`<?php\n${body}`, "public/endpoint.php")
const ids = (body: string) => scan(body).findings.map((finding) => finding.cwe)

describe("bounded PHP source flow", () => {
  it.each([
    "system(escapeshellarg($_GET['cmd']) . ' ' . escapeshellarg($_GET['arg']));",
    "$cmd = $_GET['cmd']; $cmd = escapeshellarg($cmd); system($cmd);",
    "$cmd = escapeshellarg($_GET['cmd']) . ' ' . escapeshellarg($_GET['arg']); system($cmd);",
  ])("retains escaped executable selection: %s", (body) => {
    expect(ids(body)).toContain("CWE-78")
  })

  it.each([
    "system('ping ' . escapeshellarg($_GET['host']));",
    "$cmd = 'ping ' . escapeshellarg($_GET['host']); system($cmd);",
    "$arg = escapeshellarg($_GET['host']); $cmd = 'ping ' . $arg; system($cmd);",
  ])("keeps quoted data after a fixed executable quiet: %s", (body) => {
    expect(scan(body).findings).toEqual([])
  })

  it.each(["", ";"])(
    "preserves local flow across a closing tag with terminator %j",
    (terminator) => {
      const result = analyzePhpSource(
        `<?php $cmd = $_GET['cmd']${terminator} ?>inert HTML system($fake) <?php system($cmd);`,
        "template.php"
      )
      expect(result.findings.map((finding) => finding.cwe)).toEqual(["CWE-78"])
    }
  )

  it.each([
    'system("echo \\$_GET");',
    '$cmd = $_GET["cmd"]; system("echo \\$cmd");',
    "$object->query = $_GET['field'];",
    "$arg = $_GET['host']; $arg = escapeshellarg($arg); system('ping ' . $arg);",
    "$id = $_GET['id']; $id = intval($id); $pdo->query('SELECT * FROM users WHERE id=' . $id);",
    "$cmd = $_GET['cmd']; $cmd = 'uptime'; system($cmd);",
    "proc_open(['/usr/bin/printf', '%s', $_GET['text']], [], $pipes);",
  ])("respects definite safe local syntax: %s", (body) => {
    expect(scan(body).findings).toEqual([])
  })

  it.each([
    'system("echo $_GET[cmd]");',
    'system("echo \\\\$_GET[cmd]");',
    "$arg = $_GET['host']; if ($allowed) { $arg = escapeshellarg($arg); } system('ping ' . $arg);",
    "$cmd = $_GET['cmd']; $f = function () { return 'fixed'; }; system($cmd);",
    "$cmd = $_GET['cmd']; function helper() { $cmd = 'fixed'; } system($cmd);",
    "proc_open([$_GET['binary'], 'fixed'], [], $pipes);",
    "proc_open(['/bin/sh', '-c', $_GET['cmd']], [], $pipes);",
    "proc_open(['/bin/bash', '-c', $_GET['cmd']], [], $pipes);",
    "proc_open(['/usr/bin/env', $_GET['binary']], [], $pipes);",
    "proc_open([escapeshellarg($_GET['binary']), 'fixed'], [], $pipes);",
    "proc_open($_GET['cmd'], [], $pipes);",
  ])("retains actual and alternate request-to-command flow: %s", (body) => {
    expect(ids(body)).toContain("CWE-78")
  })

  it("keeps argv command-specific injection and unknown executable identity unassessed", () => {
    const result = scan("proc_open(['/usr/bin/printf', '%s', $_GET['text']], [], $pipes);")
    expect(result.issues.join(" ")).toContain(
      "command-specific argument injection remain unassessed"
    )
  })

  it.each([
    ["system($_GET['cmd']);", "CWE-78"],
    ["$input = $_POST['cmd']; $next = $input; shell_exec('tool ' . $next);", "CWE-78"],
    [
      "$id = $_GET['id']; $sql = 'SELECT * FROM users WHERE id=' . $id; $pdo->query($sql);",
      "CWE-89",
    ],
    ["$pdo->prepare('SELECT * FROM users WHERE id=' . $_GET['id']);", "CWE-89"],
    ["unserialize($_COOKIE['state']);", "CWE-502"],
    ["include $_GET['page'];", "CWE-98"],
    ["$file = $_GET['file']; readfile('/srv/files/' . $file);", "CWE-22"],
    [
      "move_uploaded_file($_FILES['asset']['tmp_name'], '/srv/uploads/' . $_FILES['asset']['name']);",
      "CWE-434",
    ],
    ["simplexml_load_string($_POST['xml'], 'SimpleXMLElement', LIBXML_NOENT);", "CWE-611"],
    ["$url = $_GET['url']; curl_init($url);", "CWE-918"],
    ["$pdo->query(\"SELECT * FROM users WHERE name = '$name'\" . $_GET['suffix']);", "CWE-89"],
    ["DB::select('SELECT * FROM users WHERE id=' . request('id'));", "CWE-89"],
    [
      "mysqli_query($db, 'SELECT * FROM users WHERE id=' . $_GET['id'], MYSQLI_STORE_RESULT);",
      "CWE-89",
    ],
    ["$cmd = $_GET['cmd']; if ($allowed) { system($cmd); }", "CWE-78"],
    ["if ($allowed) { $cmd = $_GET['cmd']; } system($cmd);", "CWE-78"],
    ["$body = file_get_contents('php://input'); unserialize($body);", "CWE-502"],
    ["$cmd = filter_input(INPUT_POST, 'cmd'); system($cmd);", "CWE-78"],
  ])("detects bounded request flow: %s", (body, cwe) => {
    expect(ids(body)).toContain(cwe)
  })

  it.each([
    "$stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?'); $stmt->execute([$_GET['id']]);",
    "system('uptime');",
    "$arg = escapeshellarg($_GET['host']); system('ping ' . $arg);",
    "$id = intval($_GET['id']); $pdo->query('SELECT * FROM users WHERE id=' . $id);",
    "$task = ['daily' => 'date', 'health' => 'uptime'][$_GET['task']]; system($task);",
    "// system($_GET['cmd']);\n/* unserialize($_GET['data']); */",
    "$example = 'system($_GET[cmd]);';",
    "simplexml_load_string($_POST['xml'], 'SimpleXMLElement', LIBXML_NONET);",
    "move_uploaded_file($_FILES['asset']['tmp_name'], '/srv/quarantine/fixed.bin');",
  ])("keeps safe or inert controls quiet: %s", (body) => {
    expect(scan(body).findings).toEqual([])
  })

  it("does not treat context-mismatched sanitizers as safety", () => {
    expect(ids("system(htmlspecialchars($_GET['cmd']));")).toContain("CWE-78")
    expect(ids("readfile(basename($_GET['file']));")).toContain("CWE-22")
    expect(ids("curl_init(filter_var($_GET['url'], FILTER_VALIDATE_URL));")).toContain("CWE-918")
    expect(ids("unserialize($_GET['data'], ['allowed_classes' => false]);")).toContain("CWE-502")
  })

  it("retains scope, rule version and source location without patch or exploit claims", () => {
    const result = scan("system($_GET['cmd']);")
    expect(result.findings[0]?.technical_analysis).toContain(PHP_SOURCE_RULE_VERSION)
    expect(result.findings[0]?.code_locations?.[0]).toMatchObject({
      file: "public/endpoint.php",
      start_line: 2,
    })
    expect(result.findings[0]?.code_locations?.[0]).not.toHaveProperty("fix_after")
    expect(result.issues.join(" ")).toMatch(/cross-file.*authorization.*CSRF.*session/i)
  })

  it("never carries local assignments between function bodies", () => {
    expect(ids("function a() { $cmd = $_GET['cmd']; } function b() { system($cmd); }")).toEqual([])
  })

  it("bounds input, tokens and nesting and exposes unsupported constructs", () => {
    expect(scan("$x = '" + "x".repeat(600_000) + "';").issues.join(" ")).toMatch(/byte limit/)
    expect(scan("$x=1;".repeat(15_000)).issues.join(" ")).toMatch(/token limit/)
    expect(
      scan("system(" + "(".repeat(40) + "$_GET['x']" + ")".repeat(40) + ");").issues.join(" ")
    ).toMatch(/nesting limit/)
    expect(scan("$x = <<<TEXT\nhello\nTEXT;\n$handler($_GET['x']);").issues.join(" ")).toMatch(
      /unsupported/i
    )
  })

  it("reports statement and finding caps without unbounded recursion", () => {
    expect(scan("system(" + "$_GET['x'] . ".repeat(500) + "'');").issues.join(" ")).toMatch(
      /statement token limit/
    )
    const capped = scan("system($_GET['cmd']);\n".repeat(110))
    expect(capped.findings).toHaveLength(100)
    expect(capped.issues.join(" ")).toContain("finding limit")
  })
})

it.each([
  '$arg = escapeshellarg($_GET["host"]); system("ping $arg");',
  '$arg = escapeshellarg($_GET["host"]); $cmd = "ping $arg"; system($cmd);',
])("keeps sanitized PHP interpolation after a fixed executable quiet: %s", (body) => {
  expect(scan(body).findings).toEqual([])
})
it.each([
  'system("ping $_GET[host]");',
  "system('echo $(' . escapeshellarg($_GET['cmd']) . ')');",
  "system('echo $' . '(' . escapeshellarg($_GET['cmd']) . ')');",
])("retains raw interpolation or literal shell command substitution: %s", (body) => {
  expect(ids(body)).toContain("CWE-78")
})

it.each([
  "system('sh -c ' . escapeshellarg($_GET['cmd']));",
  "system('/bin/bash -c ' . escapeshellarg($_GET['cmd']));",
  "system('env ' . escapeshellarg($_GET['binary']));",
  "$cmd = 'sh -c ' . escapeshellarg($_GET['cmd']); system($cmd);",
  "system('python3 -c ' . escapeshellarg($_GET['cmd']));",
  "system('php -r ' . escapeshellarg($_GET['cmd']));",
])("retains escaped command text passed to a dispatcher or interpreter: %s", (body) => {
  expect(ids(body)).toContain("CWE-78")
})

it.each([
  "system('python3 trusted-script.py ' . escapeshellarg($_GET['argument']));",
  "system('php trusted-script.php ' . escapeshellarg($_GET['argument']));",
])("keeps an escaped data argument to a fixed interpreter script quiet: %s", (body) => {
  expect(scan(body).findings).toEqual([])
})

it.each([
  "system('python3 -I ' . escapeshellarg($_GET['script']));",
  "system('php -n ' . escapeshellarg($_GET['script']));",
])("retains script selection after interpreter options: %s", (body) => {
  expect(ids(body)).toContain("CWE-78")
})

it("retains an interpolated attacker-selected script behind an interpreter", () => {
  expect(
    ids(
      '$script = escapeshellarg($_GET["script"]); system("python3 $script " . escapeshellarg($_GET["argument"]));'
    )
  ).toContain("CWE-78")
})

it.each([
  "$cmd = 'uptime'; if ($allowed) $cmd = $_GET['cmd']; system($cmd);",
  "$cmd = $_GET['cmd']; if ($allowed) $cmd = 'uptime'; system($cmd);",
  "$cmd = 'uptime'; if ($allowed) $cmd = 'date'; else $cmd = $_GET['cmd']; system($cmd);",
  "$cmd = 'uptime'; if ($a) if ($b) $cmd = $_GET['cmd']; system($cmd);",
])("retains possible assignments in unbraced branches: %s", (body) => {
  expect(ids(body)).toContain("CWE-78")
})

it.each([
  ["system('ping ' . $helper->escapeshellarg($_GET['host']));", "CWE-78"],
  ["system('ping ' . Fake::escapeshellarg($_GET['host']));", "CWE-78"],
  ["system('ping ' . evil\\escapeshellarg($_GET['host']));", "CWE-78"],
  ["$pdo->query('SELECT ' . $helper->intval($_GET['id']));", "CWE-89"],
])("does not trust a custom method or namespaced sanitizer: %s", (body, cwe) => {
  expect(ids(body)).toContain(cwe)
})

it("recognizes explicitly global PHP sanitizers", () => {
  expect(ids("system('ping ' . \\escapeshellarg($_GET['host']));")).toEqual([])
  expect(ids("$pdo->query('SELECT ' . \\intval($_GET['id']));")).toEqual([])
})

it.each([
  "namespace App; function escapeshellarg($value) { return $value; } system('ping ' . escapeshellarg($_GET['host']));",
  "use function Evil\\escapeshellarg; system('ping ' . escapeshellarg($_GET['host']));",
  "use Evil\\{function escapeshellarg}; system('ping ' . escapeshellarg($_GET['host']));",
])("keeps bare sanitizer resolution conservative for namespaces and imports: %s", (body) => {
  expect(ids(body)).toContain("CWE-78")
  expect(scan(body).issues.join(" ")).toContain("function resolution")
})

it.each([
  "namespace App; system('ping ' . \\escapeshellarg($_GET['host']));",
  "use function Evil\\escapeshellarg; system('ping ' . \\escapeshellarg($_GET['host']));",
  "use Vendor\\Helper; system('ping ' . escapeshellarg($_GET['host']));",
])("retains provable global sanitizer controls: %s", (body) => {
  expect(ids(body)).toEqual([])
})
