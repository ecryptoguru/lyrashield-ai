import { describe, expect, it } from "vitest"
import { analyzePhpSource, PHP_SOURCE_RULE_VERSION } from "./php-source"

const scan = (body: string) => analyzePhpSource(`<?php\n${body}`, "public/endpoint.php")
const ids = (body: string) => scan(body).findings.map((finding) => finding.cwe)

describe("bounded PHP source flow", () => {
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
