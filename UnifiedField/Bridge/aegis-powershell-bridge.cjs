'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.HF_BRIDGE_PORT || 8787);
const TOKEN = process.env.HF_BRIDGE_TOKEN || '';
if (TOKEN.length < 32) throw new Error('HF_BRIDGE_TOKEN must be configured with at least 32 characters; refusing to start without an operator-held secret.');
const REPO = process.env.HF_REPO || process.cwd();
const MAX_BODY = 2048;
const TIMEOUT_MS = 12000;

const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "switch ($env:HF_ACTION) {",
  "  'health' {",
  "    $result = [ordered]@{ status='online'; runtime='Windows PowerShell'; version=$PSVersionTable.PSVersion.ToString(); computer=$env:COMPUTERNAME; processId=$PID }",
  "  }",
  "  'system-info' {",
  "    $os = Get-CimInstance -ClassName Win32_OperatingSystem",
  "    $result = [ordered]@{ computer=$env:COMPUTERNAME; operatingSystem=$os.Caption; version=$os.Version; architecture=$env:PROCESSOR_ARCHITECTURE; freeMemoryMB=[math]::Round(($os.FreePhysicalMemory / 1024), 1) }",
  "  }",
  "  'git-status' {",
  "    $repo = $env:HF_REPO",
  "    if (-not (Test-Path -LiteralPath $repo -PathType Container)) { throw 'Repository directory not found' }",
  "    $git = Get-Command git.exe -ErrorAction Stop",
  "    $lines = @(& $git.Source -C $repo status --short --branch)",
  "    if ($LASTEXITCODE -ne 0) { throw 'git status returned a non-zero exit code' }",
  "    $result = [ordered]@{ repository=$repo; status=$lines }",
  "  }",
  "  default { throw 'Action is not allowlisted' }",
  "}",
  "ConvertTo-Json -InputObject $result -Depth 5 -Compress"
].join('\n');

const DASHBOARD = [
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AEGIS Nexus Bridge</title><style>',
  'body{font:16px system-ui;background:#0d1117;color:#e6edf3;max-width:760px;margin:40px auto;padding:0 20px}',
  'input{padding:10px;width:min(100%,420px);background:#161b22;color:#e6edf3;border:1px solid #8b949e;border-radius:6px}',
  'h1{color:#00d7b0}button{padding:12px 16px;margin:6px;background:#161b22;color:#e6edf3;border:1px solid #00d7b0;border-radius:8px;cursor:pointer}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#161b22;padding:16px;border-radius:8px;min-height:120px}',
  '</style></head><body><h1>AEGIS Nexus ↔ PowerShell</h1>',
  '<p>Authenticated local bridge. Only allowlisted read-only actions are enabled.</p>',
  '<label for="token">Operator token (not stored):</label><br><input id="token" type="password" autocomplete="off" spellcheck="false">',
  '<button data-action="health">Health check</button><button data-action="system-info">Windows system info</button><button data-action="git-status">Git status</button>',
  '<pre id="out" role="status" aria-live="polite" aria-atomic="true">Bridge ready. Select an operation.</pre><script>',
  'const token=()=>document.getElementById("token").value.trim();',
  'document.querySelectorAll("button[data-action]").forEach(b=>b.addEventListener("click",async()=>{',
  'const out=document.getElementById("out");if(token().length<32){out.textContent="Enter the configured operator token.";return;}out.textContent="Running "+b.dataset.action+"...";',
  'try{const r=await fetch("/v1/execute",{method:"POST",headers:{"Authorization":"Bearer "+token(),"Content-Type":"application/json"},body:JSON.stringify({action:b.dataset.action})});',
  'const j=await r.json();out.textContent=JSON.stringify(j,null,2);}',
  'catch(e){out.textContent="ERROR: "+e.message;}',
  '}));</script></body></html>'
].join('');

const ALLOWED = new Set(['health', 'system-info', 'git-status']);

function reply(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(JSON.stringify(value));
}

function isAuthorized(req) {
  const supplied = req.headers.authorization || '';
  const expected = 'Bearer ' + TOKEN;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runPowerShell(action) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'RemoteSigned', '-Command', POWERSHELL_SCRIPT
    ], {
      windowsHide: true,
      timeout: TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
      env: { ...process.env, HF_ACTION: action, HF_REPO: REPO }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'PowerShell failed').trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('PowerShell returned invalid JSON: ' + stdout.slice(0, 500)));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.host !== HOST + ':' + PORT) {
    return reply(res, 403, { error: 'Invalid Host header' });
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    return res.end(DASHBOARD);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method !== 'POST' || req.url !== '/v1/execute') {
    return reply(res, 404, { error: 'Not found' });
  }
  if (req.headers.origin && req.headers.origin !== 'http://' + HOST + ':' + PORT) return reply(res, 403, { error: 'Cross-origin requests are not permitted' });
  if (!isAuthorized(req)) return reply(res, 401, { error: 'Unauthorized' });
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return reply(res, 415, { error: 'Content-Type must be application/json' });
  }

  let body = '';
  let oversized = false;
  req.on('data', chunk => {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY) {
      oversized = true;
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (oversized) return;
    try {
      const payload = JSON.parse(body || '{}');
      if (!payload || typeof payload.action !== 'string' || !ALLOWED.has(payload.action)) {
        return reply(res, 400, { error: 'Action not permitted', allowed: Array.from(ALLOWED) });
      }
      const result = await runPowerShell(payload.action);
      reply(res, 200, { ok: true, action: payload.action, timestamp: new Date().toISOString(), result });
    } catch (error) {
      reply(res, 500, { ok: false, error: error.message });
    }
  });
});

server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

server.listen(PORT, HOST, () => {
  console.log('AEGIS PowerShell bridge: http://' + HOST + ':' + PORT);
  console.log('Repository: ' + REPO);
  console.log('Allowed actions: ' + Array.from(ALLOWED).join(', '));
  console.log('Opening local control panel...');
  execFile('cmd.exe', ['/c', 'start', '', 'http://' + HOST + ':' + PORT], { windowsHide: true });
  console.log('Press Ctrl+C to stop.');
});
