export interface Env {
  CF_API_TOKEN: string;
  ZONE_ID: string;
  RECORD_NAME: string;
  ADMIN_PASSWORD: string;
  ACCOUNT_ID: string;
}

interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  modified_on: string;
}

interface Tunnel {
  id: string;
  name: string;
  status: string;
  created_at: string;
  connections?: Array<{ id: string; version: string; origin_ip: string }>;
  tunnel_secret?: string;
}

interface PublicHostname {
  hostname: string;
  service: string;
  id?: string;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { total_count: number };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok");

    if (path === "/nic/update" || path === "/update") return handleUpdate(request, env);

    if (path === "/nic/checkip" || path === "/checkip") {
      return new Response(request.headers.get("cf-connecting-ip") || "unknown");
    }

    if (path === "/admin" || path === "/admin/") {
      return requireAdmin(request, env) ? dashboard() : unauthorized();
    }

    if (path === "/api/records" && request.method === "GET") {
      if (!requireAdmin(request, env)) return unauthorized();
      return listRecords(env);
    }
    if (path === "/api/records" && request.method === "POST") {
      if (!requireAdmin(request, env)) return unauthorized();
      return createRecord(request, env);
    }
    if (path.startsWith("/api/records/") && request.method === "DELETE") {
      if (!requireAdmin(request, env)) return unauthorized();
      return deleteRecord(path.split("/api/records/")[1], env);
    }
    if (path.startsWith("/api/records/") && request.method === "PUT") {
      if (!requireAdmin(request, env)) return unauthorized();
      return updateRecord(path.split("/api/records/")[1], request, env);
    }

    if (path === "/api/tunnels" && request.method === "GET") {
      if (!requireAdmin(request, env)) return unauthorized();
      return listTunnels(env);
    }
    if (path === "/api/tunnels" && request.method === "POST") {
      if (!requireAdmin(request, env)) return unauthorized();
      return createTunnel(request, env);
    }
    if (path.startsWith("/api/tunnels/") && request.method === "GET" && !path.includes("/hostnames")) {
      if (!requireAdmin(request, env)) return unauthorized();
      return getTunnel(path.split("/api/tunnels/")[1], env);
    }
    if (path.startsWith("/api/tunnels/") && request.method === "DELETE" && !path.includes("/hostnames")) {
      if (!requireAdmin(request, env)) return unauthorized();
      return deleteTunnel(path.split("/api/tunnels/")[1], env);
    }
    if (path.includes("/hostnames") && request.method === "POST") {
      if (!requireAdmin(request, env)) return unauthorized();
      const tunnelId = path.split("/api/tunnels/")[1].split("/")[0];
      return addHostname(tunnelId, request, env);
    }
    if (path.includes("/hostnames/") && request.method === "DELETE") {
      if (!requireAdmin(request, env)) return unauthorized();
      const parts = path.split("/api/tunnels/")[1].split("/");
      return deleteHostname(parts[0], parts[2], env);
    }

    return new Response("Synology DDNS + Tunnel Manager\n\nEndpoints:\n  /admin              - Management dashboard\n  /update             - DDNS update\n  /nic/update         - Synology-compatible update\n  /checkip            - Public IP\n  /health             - Health check\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

function requireAdmin(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) return false;
  const [, pass] = atob(authHeader.slice(6)).split(":");
  return pass === env.ADMIN_PASSWORD;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin"', "Content-Type": "text/plain" },
  });
}

async function cfFetch(path: string, env: Env, method = "GET", body?: object): Promise<Response> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp;
}

async function safeJson(resp: Promise<Response>): Promise<CloudflareResponse<unknown>> {
  try {
    const r = await resp;
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { return { success: false, errors: [{ code: 0, message: text || "Invalid response" }], result: null }; }
  } catch (e) {
    return { success: false, errors: [{ code: 0, message: e instanceof Error ? e.message : "Network error" }], result: null };
  }
}

async function listRecords(env: Env): Promise<Response> {
  const data = await safeJson(cfFetch(`/zones/${env.ZONE_ID}/dns_records?type=A`, env));
  return jsonResponse(data);
}

async function createRecord(request: Request, env: Env): Promise<Response> {
  const { name, content } = await request.json<{ name: string; content: string }>();
  const data = await safeJson(cfFetch(`/zones/${env.ZONE_ID}/dns_records`, env, "POST", {
    type: "A", name, content, ttl: 1, proxied: false,
  }));
  return jsonResponse(data, data.success ? 201 : 400);
}

async function deleteRecord(id: string, env: Env): Promise<Response> {
  const data = await safeJson(cfFetch(`/zones/${env.ZONE_ID}/dns_records/${id}`, env, "DELETE"));
  return jsonResponse(data);
}

async function updateRecord(id: string, request: Request, env: Env): Promise<Response> {
  const { name, content } = await request.json<{ name: string; content: string }>();
  const data = await safeJson(cfFetch(`/zones/${env.ZONE_ID}/dns_records/${id}`, env, "PUT", {
    type: "A", name, content, ttl: 1, proxied: false,
  }));
  return jsonResponse(data);
}

async function listTunnels(env: Env): Promise<Response> {
  const data = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel`, env));
  return jsonResponse(data);
}

async function getTunnel(id: string, env: Env): Promise<Response> {
  const data = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${id}`, env));
  if (!data.success) return jsonResponse(data, 404);

  const configData = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${id}/configurations`, env));
  return jsonResponse({ ...data, result: { ...(data.result as object), config: configData.result } });
}

async function createTunnel(request: Request, env: Env): Promise<Response> {
  const { name } = await request.json<{ name: string }>();
  const data = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel`, env, "POST", { name }));
  return jsonResponse(data, data.success ? 201 : 400);
}

async function deleteTunnel(id: string, env: Env): Promise<Response> {
  const data = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${id}`, env, "DELETE"));
  return jsonResponse(data);
}

async function addHostname(tunnelId: string, request: Request, env: Env): Promise<Response> {
  const { hostname, service } = await request.json<{ hostname: string; service: string }>();
  const data = await safeJson(cfFetch(
    `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    env, "PUT", {
      config: {
        ingress: [
          { hostname, service },
          { service: "http_status:404" },
        ],
      },
    }
  ));
  return jsonResponse(data);
}

async function deleteHostname(tunnelId: string, hostname: string, env: Env): Promise<Response> {
  const configData = await safeJson(cfFetch(`/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, env));
  if (!configData.success) return jsonResponse(configData, 404);

  const config = configData.result?.config || configData.result;
  const ingress = config?.ingress || [];
  const newIngress = ingress.filter((r: { hostname?: string }) => r.hostname !== hostname);

  if (newIngress.length <= 1) {
    newIngress.push({ service: "http_status:404" });
  }

  const data = await safeJson(cfFetch(
    `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`,
    env, "PUT", { config: { ingress: newIngress } }
  ));
  return jsonResponse(data);
}

async function handleUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get("hostname") || url.searchParams.get("host");
  const myip = url.searchParams.get("myip") || url.searchParams.get("ip");

  if (!hostname || !myip) return plainText("badauth", 401);

  const authHeader = request.headers.get("Authorization");
  const basicAuth = authHeader?.startsWith("Basic ") ? atob(authHeader.slice(6)) : null;

  if (basicAuth) {
    const [, pass] = basicAuth.split(":");
    if (pass !== env.CF_API_TOKEN) return plainText("badauth", 401);
  }

  try {
    const cfApiBase = `/zones/${env.ZONE_ID}/dns_records`;
    const listData = await safeJson(cfFetch(`${cfApiBase}?type=A&name=${encodeURIComponent(hostname)}`, env)) as CloudflareResponse<DNSRecord[]>;

    if (!listData.success) return plainText("badauth", 500);

    const existing = listData.result.find((r) => r.type === "A" && r.name === hostname);

    if (existing) {
      if (existing.content === myip) return plainText("good " + myip);
      const updateData = await safeJson(cfFetch(`${cfApiBase}/${existing.id}`, env, "PUT", {
        type: "A", name: hostname, content: myip, ttl: 1, proxied: false,
      })) as CloudflareResponse<DNSRecord>;
      if (!updateData.success) return plainText("fail updating", 500);
      return plainText("good " + myip);
    }

    const createData = await safeJson(cfFetch(cfApiBase, env, "POST", {
      type: "A", name: hostname, content: myip, ttl: 1, proxied: false,
    })) as CloudflareResponse<DNSRecord>;
    if (!createData.success) return plainText("fail creating", 500);
    return plainText("good " + myip);
  } catch (err) {
    return plainText("fail " + (err instanceof Error ? err.message : "unknown"), 500);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function plainText(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function dashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Synology Manager</title>
<style>
:root{--bg:#0a0a0a;--card:#111;--border:#222;--accent:#f6821f;--text:#e0e0e0;--muted:#888;--danger:#e53e3e;--success:#38a169;--blue:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:960px;margin:0 auto;padding:2rem 1rem}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2rem;flex-wrap:wrap;gap:1rem}
h1{font-size:1.5rem;font-weight:600}h1 span{color:var(--accent)}
.badge{background:var(--accent);color:#000;font-size:.7rem;padding:2px 8px;border-radius:9999px;font-weight:700;text-transform:uppercase}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
.card h2{font-size:1rem;margin-bottom:1rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:500}
.tabs{display:flex;gap:0;margin-bottom:1.5rem;border-bottom:1px solid var(--border)}
.tab{padding:.75rem 1.5rem;cursor:pointer;font-size:.9rem;color:var(--muted);border-bottom:2px solid transparent;transition:all .15s;background:none;border-top:none;border-left:none;border-right:none}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab:hover{color:var(--text)}
.tab-content{display:none}.tab-content.active{display:block}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.75rem 1rem;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-size:.8rem;text-transform:uppercase;font-weight:500}
td{font-size:.9rem}
.ip{font-family:'SF Mono',Monaco,monospace;color:var(--accent)}
.name{font-weight:500}.time{color:var(--muted);font-size:.8rem}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}
button{cursor:pointer;border:none;border-radius:6px;padding:.4rem .8rem;font-size:.8rem;font-weight:500;transition:opacity .15s}
button:hover{opacity:.85}
.btn-edit{background:var(--blue);color:#fff}
.btn-delete{background:var(--danger);color:#fff}
.btn-primary{background:var(--accent);color:#000;font-weight:600}
.btn-sm{padding:.3rem .6rem;font-size:.75rem}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.form-row{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end}
.form-group{display:flex;flex-direction:column;gap:.3rem;flex:1;min-width:140px}
.form-group label{font-size:.8rem;color:var(--muted)}
input,select{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text);font-size:.9rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--accent)}
select{cursor:pointer}
.empty{text-align:center;padding:2rem;color:var(--muted)}
.toast{position:fixed;bottom:1.5rem;right:1.5rem;padding:.75rem 1.25rem;border-radius:8px;color:#fff;font-size:.85rem;font-weight:500;z-index:100;animation:slideIn .3s ease}
.toast.success{background:var(--success)}.toast.error{background:var(--danger)}
@keyframes slideIn{from{transform:translateY(1rem);opacity:0}to{transform:translateY(0);opacity:1}}
.endpoint{font-family:'SF Mono',Monaco,monospace;background:var(--bg);padding:.5rem .75rem;border-radius:6px;font-size:.85rem;display:block;margin-top:.5rem;color:var(--accent);word-break:break-all}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:600px){.info-grid{grid-template-columns:1fr}.form-row{flex-direction:column}}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:50;align-items:center;justify-content:center}
.modal-overlay.active{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;width:90%;max-width:480px}
.modal h3{margin-bottom:1rem}.modal .form-row{margin-bottom:1rem}.modal .actions{justify-content:flex-end;margin-top:1rem}
.tunnel-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:.75rem}
.tunnel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem}
.tunnel-name{font-weight:600;font-size:1rem}
.tunnel-status{display:inline-flex;align-items:center;gap:.3rem;font-size:.8rem}
.tunnel-status .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot-green{background:var(--success)}.dot-red{background:var(--danger)}.dot-yellow{background:#eab308}
.tunnel-meta{font-size:.8rem;color:var(--muted);margin-bottom:.5rem}
.tunnel-hostnames{margin-top:.75rem}
.tunnel-hostnames h4{font-size:.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:.4rem}
.hostname-item{display:flex;justify-content:space-between;align-items:center;padding:.4rem 0;border-top:1px solid var(--border);font-size:.85rem}
.hostname-item:first-child{border-top:none}
.code-block{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;font-family:'SF Mono',Monaco,monospace;font-size:.8rem;color:var(--accent);word-break:break-all;white-space:pre-wrap;margin-top:.75rem;line-height:1.6}
.copy-btn{background:var(--border);color:var(--text);font-size:.7rem;padding:.25rem .5rem;border-radius:4px;cursor:pointer;margin-left:.5rem}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>Synology</span> Manager</h1>
    <span class="badge">Cloudflare</span>
  </header>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('dns')">DNS Records</button>
    <button class="tab" onclick="switchTab('tunnels')">Cloudflare Tunnels</button>
    <button class="tab" onclick="switchTab('setup')">Quick Setup</button>
  </div>

  <div id="tab-dns" class="tab-content active">
    <div class="card">
      <h2>Add DNS Record</h2>
      <div class="form-row">
        <div class="form-group"><label>Hostname</label><input id="new-name" placeholder="nas.example.com" /></div>
        <div class="form-group"><label>IP Address</label><input id="new-ip" placeholder="1.2.3.4" /></div>
        <button class="btn-primary" onclick="createRecord()" style="height:36px">Add</button>
      </div>
    </div>
    <div class="card">
      <h2>DNS A Records</h2>
      <div id="records-loading" class="empty">Loading records...</div>
      <table id="records-table" style="display:none">
        <thead><tr><th>Hostname</th><th>IP Address</th><th>Last Updated</th><th>Actions</th></tr></thead>
        <tbody id="records-body"></tbody>
      </table>
      <div id="records-empty" class="empty" style="display:none">No A records found</div>
    </div>
  </div>

  <div id="tab-tunnels" class="tab-content">
    <div class="card">
      <h2>Create Tunnel</h2>
      <div class="form-row">
        <div class="form-group"><label>Tunnel Name</label><input id="tunnel-name" placeholder="synology-nas" /></div>
        <button class="btn-primary" onclick="createTunnel()" style="height:36px">Create</button>
      </div>
    </div>
    <div class="card">
      <h2>Cloudflare Tunnels</h2>
      <div id="tunnels-loading" class="empty">Loading tunnels...</div>
      <div id="tunnels-list"></div>
      <div id="tunnels-empty" class="empty" style="display:none">No tunnels found</div>
    </div>
  </div>

  <div id="tab-setup" class="tab-content">
    <div class="card">
      <h2>Quick Setup</h2>
      <div class="info-grid">
        <div>
          <label style="font-size:.8rem;color:var(--muted)">DDNS Update Endpoint</label>
          <code class="endpoint" id="ddns-endpoint">Loading...</code>
        </div>
        <div>
          <label style="font-size:.8rem;color:var(--muted)">Health Check</label>
          <code class="endpoint" id="health-endpoint">Loading...</code>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Synology DSM Configuration</h2>
      <p style="font-size:.9rem;margin-bottom:1rem">Control Panel → External Access → DDNS → Add</p>
      <table>
        <thead><tr><th>Field</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Service Provider</td><td class="name">Custom</td></tr>
          <tr><td>Hostname</td><td class="ip">nas.awesomemm.com</td></tr>
          <tr><td>Server Address</td><td class="ip" id="setup-endpoint">Loading...</td></tr>
          <tr><td>Username</td><td>admin</td></tr>
          <tr><td>Password</td><td class="ip">Your API token</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Cloudflare Tunnel (No Public IP)</h2>
      <p style="font-size:.9rem;margin-bottom:1rem">If your ISP uses CGNAT, use a tunnel to expose your NAS.</p>
      <ol style="font-size:.9rem;padding-left:1.2rem;line-height:2">
        <li>Create a tunnel above in the <strong>Tunnels</strong> tab</li>
        <li>Install <code>cloudflared</code> on your Synology (Docker or SSH)</li>
        <li>Add a public hostname pointing to <code>http://localhost:5000</code></li>
        <li>Access your NAS at the public hostname from anywhere</li>
      </ol>
    </div>
  </div>
</div>

<div id="edit-modal" class="modal-overlay">
  <div class="modal">
    <h3>Edit Record</h3>
    <input type="hidden" id="edit-id" />
    <div class="form-row">
      <div class="form-group"><label>Hostname</label><input id="edit-name" /></div>
      <div class="form-group"><label>IP Address</label><input id="edit-ip" /></div>
    </div>
    <div class="actions">
      <button onclick="closeModal()" class="btn-outline">Cancel</button>
      <button class="btn-primary" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<div id="hostname-modal" class="modal-overlay">
  <div class="modal">
    <h3>Add Public Hostname</h3>
    <input type="hidden" id="hn-tunnel-id" />
    <div class="form-row">
      <div class="form-group"><label>Subdomain</label><input id="hn-subdomain" placeholder="nas" /></div>
      <div class="form-group"><label>Service URL</label><input id="hn-service" placeholder="http://localhost:5000" /></div>
    </div>
    <div class="actions">
      <button onclick="closeHostnameModal()" class="btn-outline">Cancel</button>
      <button class="btn-primary" onclick="addHostname()">Add</button>
    </div>
  </div>
</div>

<div id="install-modal" class="modal-overlay">
  <div class="modal" style="max-width:600px">
    <h3>Tunnel Install Command</h3>
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Run this on your Synology (via SSH or Docker):</p>
    <div class="code-block" id="install-command"></div>
    <div class="actions" style="margin-top:1rem">
      <button onclick="closeInstallModal()" class="btn-outline">Close</button>
      <button class="btn-primary" onclick="copyInstallCmd()">Copy</button>
    </div>
  </div>
</div>

<script>
const BASE = location.origin;
document.getElementById('ddns-endpoint').textContent = BASE + '/nic/update?hostname=<your-hostname>&myip=<your-ip>';
document.getElementById('health-endpoint').textContent = BASE + '/health';
document.getElementById('setup-endpoint').textContent = BASE + '/nic/update?hostname=nas.awesomemm.com&myip=<your-ip>';

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[onclick="switchTab(\\'' + name + '\\')"]').classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'dns') loadRecords();
  if (name === 'tunnels') loadTunnels();
}

async function api(path, opts = {}) {
  const resp = await fetch(BASE + path, { ...opts, headers: { ...opts.headers, 'Content-Type': 'application/json' } });
  return resp.json();
}

async function loadRecords() {
  try {
    const data = await api('/api/records');
    const tbody = document.getElementById('records-body');
    document.getElementById('records-loading').style.display = 'none';
    if (!data.success || !data.result.length) { document.getElementById('records-empty').style.display = 'block'; document.getElementById('records-table').style.display = 'none'; return; }
    document.getElementById('records-table').style.display = 'table';
    document.getElementById('records-empty').style.display = 'none';
    tbody.innerHTML = data.result.map(r =>
      '<tr><td class="name">' + r.name + '</td><td class="ip">' + r.content + '</td><td class="time">' + new Date(r.modified_on).toLocaleString() + '</td><td class="actions"><button class="btn-edit btn-sm" onclick="openEdit(\\'' + r.id + '\\',\\'' + r.name + '\\',\\'' + r.content + '\\')">Edit</button><button class="btn-delete btn-sm" onclick="deleteRecord(\\'' + r.id + '\\',\\'' + r.name + '\\')">Delete</button></td></tr>'
    ).join('');
  } catch (e) { document.getElementById('records-loading').textContent = 'Failed to load records'; }
}

async function createRecord() {
  const name = document.getElementById('new-name').value.trim();
  const content = document.getElementById('new-ip').value.trim();
  if (!name || !content) return toast('Fill in all fields', 'error');
  const data = await api('/api/records', { method: 'POST', body: JSON.stringify({ name, content }) });
  if (data.success) { toast('Record created'); document.getElementById('new-name').value = ''; document.getElementById('new-ip').value = ''; loadRecords(); }
  else toast(data.errors?.[0]?.message || 'Failed', 'error');
}

async function deleteRecord(id, name) {
  if (!confirm('Delete ' + name + '?')) return;
  const data = await api('/api/records/' + id, { method: 'DELETE' });
  if (data.success) { toast('Record deleted'); loadRecords(); } else toast('Failed to delete', 'error');
}

function openEdit(id, name, ip) {
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = name;
  document.getElementById('edit-ip').value = ip;
  document.getElementById('edit-modal').classList.add('active');
}
function closeModal() { document.getElementById('edit-modal').classList.remove('active'); }

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const name = document.getElementById('edit-name').value.trim();
  const content = document.getElementById('edit-ip').value.trim();
  const data = await api('/api/records/' + id, { method: 'PUT', body: JSON.stringify({ name, content }) });
  if (data.success) { toast('Record updated'); closeModal(); loadRecords(); } else toast('Failed to update', 'error');
}

async function loadTunnels() {
  try {
    const data = await api('/api/tunnels');
    document.getElementById('tunnels-loading').style.display = 'none';
    if (!data.success || !data.result.length) { document.getElementById('tunnels-empty').style.display = 'block'; return; }
    document.getElementById('tunnels-empty').style.display = 'none';
    const list = document.getElementById('tunnels-list');
    list.innerHTML = data.result.map(t => {
      const status = t.status === 'healthy' ? 'green' : t.status === 'degraded' ? 'yellow' : 'red';
      const connections = t.connections ? t.connections.length : 0;
      return '<div class="tunnel-card">' +
        '<div class="tunnel-header"><span class="tunnel-name">' + t.name + '</span>' +
        '<span class="tunnel-status"><span class="dot dot-' + status + '"></span>' + t.status + ' (' + connections + ' connections)</span></div>' +
        '<div class="tunnel-meta">ID: ' + t.id + ' · Created: ' + new Date(t.created_at).toLocaleDateString() + '</div>' +
        '<div class="actions">' +
        '<button class="btn-primary btn-sm" onclick="openHostnameModal(\\'' + t.id + '\\')">Add Hostname</button>' +
        '<button class="btn-edit btn-sm" onclick="showInstall(\\'' + t.id + '\\')">Install Command</button>' +
        '<button class="btn-delete btn-sm" onclick="deleteTunnel(\\'' + t.id + '\\',\\'' + t.name + '\\')">Delete</button>' +
        '</div>' +
        '<div class="tunnel-hostnames"><h4>Public Hostnames</h4><div id="hn-' + t.id + '">Loading...</div></div>' +
        '</div>';
    }).join('');
    data.result.forEach(t => loadHostnames(t.id));
  } catch (e) { document.getElementById('tunnels-loading').textContent = 'Failed to load tunnels'; }
}

async function loadHostnames(tunnelId) {
  const data = await api('/api/tunnels/' + tunnelId);
  const el = document.getElementById('hn-' + tunnelId);
  if (!el) return;
  if (!data.success || !data.result?.config?.config?.ingress) { el.innerHTML = '<div style="font-size:.8rem;color:var(--muted)">No hostnames</div>'; return; }
  const ingress = data.result.config.config.ingress || data.result.config?.ingress || [];
  const hostnames = ingress.filter(r => r.hostname);
  if (!hostnames.length) { el.innerHTML = '<div style="font-size:.8rem;color:var(--muted)">No hostnames configured</div>'; return; }
  el.innerHTML = hostnames.map(h =>
    '<div class="hostname-item"><span>' + h.hostname + ' → ' + h.service + '</span>' +
    '<button class="btn-delete btn-sm" onclick="deleteHostname(\\'' + tunnelId + '\\',\\'' + h.hostname + '\\')">Remove</button></div>'
  ).join('');
}

async function createTunnel() {
  const name = document.getElementById('tunnel-name').value.trim();
  if (!name) return toast('Enter a tunnel name', 'error');
  const data = await api('/api/tunnels', { method: 'POST', body: JSON.stringify({ name }) });
  if (data.success) { toast('Tunnel created'); document.getElementById('tunnel-name').value = ''; loadTunnels(); }
  else toast(data.errors?.[0]?.message || 'Failed to create tunnel', 'error');
}

async function deleteTunnel(id, name) {
  if (!confirm('Delete tunnel "' + name + '"?')) return;
  const data = await api('/api/tunnels/' + id, { method: 'DELETE' });
  if (data.success) { toast('Tunnel deleted'); loadTunnels(); } else toast('Failed to delete', 'error');
}

function openHostnameModal(tunnelId) {
  document.getElementById('hn-tunnel-id').value = tunnelId;
  document.getElementById('hn-subdomain').value = '';
  document.getElementById('hn-service').value = 'http://localhost:5000';
  document.getElementById('hostname-modal').classList.add('active');
}
function closeHostnameModal() { document.getElementById('hostname-modal').classList.remove('active'); }

async function addHostname() {
  const tunnelId = document.getElementById('hn-tunnel-id').value;
  const subdomain = document.getElementById('hn-subdomain').value.trim();
  const service = document.getElementById('hn-service').value.trim();
  if (!subdomain || !service) return toast('Fill in all fields', 'error');
  const hostname = subdomain + '.awesomemm.com';
  const data = await api('/api/tunnels/' + tunnelId + '/hostnames', { method: 'POST', body: JSON.stringify({ hostname, service }) });
  if (data.success) { toast('Hostname added'); closeHostnameModal(); loadHostnames(tunnelId); }
  else toast(data.errors?.[0]?.message || 'Failed to add hostname', 'error');
}

async function deleteHostname(tunnelId, hostname) {
  if (!confirm('Remove ' + hostname + '?')) return;
  const data = await api('/api/tunnels/' + tunnelId + '/hostnames/' + hostname, { method: 'DELETE' });
  if (data.success) { toast('Hostname removed'); loadHostnames(tunnelId); } else toast('Failed to remove', 'error');
}

async function showInstall(tunnelId) {
  const data = await api('/api/tunnels/' + tunnelId);
  if (!data.success) return toast('Failed to get tunnel info', 'error');
  const token = data.result.tunnel_secret || 'YOUR_TUNNEL_TOKEN';
  const cmd = '# Docker (recommended for Synology)\\n' +
    'docker run -d --name cloudflared --restart unless-stopped \\\\\\n' +
    '  cloudflare/cloudflared:latest tunnel --no-autoupdate run \\\\\\n' +
    '  --token ' + token + '\\n\\n' +
    '# Or via SSH:\\n' +
    'cloudflared service install ' + token;
  document.getElementById('install-command').textContent = cmd.replace(/\\\\n/g, '\\n');
  document.getElementById('install-modal').classList.add('active');
}
function closeInstallModal() { document.getElementById('install-modal').classList.remove('active'); }
function copyInstallCmd() {
  navigator.clipboard.writeText(document.getElementById('install-command').textContent);
  toast('Copied to clipboard');
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

loadRecords();
</script>
</body>
</html>`;
