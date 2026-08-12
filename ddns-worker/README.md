# Synology DDNS Server (Cloudflare Workers)

Dynamic DNS server for Synology NAS using Cloudflare DNS. Automatically updates your DNS A record whenever your IP changes.

## How It Works

Synology NAS sends periodic DDNS update requests → Cloudflare Worker receives the request → Updates the DNS A record via Cloudflare API.

```
Synology NAS ──HTTP──▶ Cloudflare Worker ──API──▶ Cloudflare DNS
                       (workers.dev)              (A record updated)
```

## Prerequisites

- Cloudflare account with a domain zone
- API token with `Zone:DNS:Edit` and `Zone:Zone:Read` permissions
- Synology DSM with DDNS support

## Deployment

### 1. Install dependencies

```bash
cd ddns-worker
npm install
```

### 2. Configure wrangler.jsonc

Update `account_id` and `ZONE_ID` in `wrangler.jsonc`:

```jsonc
{
  "name": "synology-ddns",
  "account_id": "YOUR_ACCOUNT_ID",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "vars": {
    "ZONE_ID": "YOUR_ZONE_ID"
  }
}
```

Find your Zone ID in the Cloudflare dashboard → Overview → right sidebar.

### 3. Set secrets

```bash
# Your Cloudflare API token (Zone:DNS:Edit scope)
echo "YOUR_API_TOKEN" | npx wrangler secret put CF_API_TOKEN

# The full hostname to update (e.g., nas.example.com)
echo "nas.example.com" | npx wrangler secret put RECORD_NAME

# Password for the management dashboard
echo "YOUR_ADMIN_PASSWORD" | npx wrangler secret put ADMIN_PASSWORD
```

### 4. Deploy

```bash
npx wrangler deploy
```

Your worker will be available at:
```
https://synology-ddns.YOUR_SUBDOMAIN.workers.dev
```

### 5. Custom Domain (Optional)

To use `synology-ddns.awesomemm.com` instead of `workers.dev`:

1. Go to Cloudflare Dashboard → your zone → **Workers & Pages**
2. Click your worker → **Settings** → **Triggers** → **Custom Domains**
3. Add `synology-ddns.awesomemm.com`
4. Cloudflare will auto-create the DNS record and SSL certificate

Or manually create a CNAME record:
```
Type: CNAME
Name: synology-ddns
Target: synology-ddns.YOUR_SUBDOMAIN.workers.dev
Proxy: DNS only (grey cloud)
```

## Synology DSM Setup

1. Open **Control Panel → External Access → DDNS**
2. Click **Add**
3. Fill in:

| Field | Value |
|-------|-------|
| Service Provider | **Custom** |
| Hostname | `nas.awesomemm.com` |
| Server Address | `https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/nic/update` |
| Username | `admin` |
| Password | Your API token |

4. Click **Test Connection** then **OK**

## Exposing Synology Without Public IP (Cloudflare Tunnel)

If your ISP uses CGNAT or you don't have a public IP, use **Cloudflare Tunnel** to securely expose your Synology NAS services.

### How It Works

```
Internet ──▶ Cloudflare Edge ──▶ Tunnel ──▶ Synology NAS (local network)
              (anycast)          (encrypted)   (5000, 5001, etc.)
```

No port forwarding needed. No public IP needed. Your NAS connects outbound to Cloudflare.

### Step 1: Create Tunnel in Cloudflare Dashboard

1. Go to **https://one.dash.cloudflare.com** → **Networks** → **Tunnels**
2. Click **Create a tunnel**
3. Choose **Cloudflared** connector
4. Name it: `synology-nas`
5. Copy the install command (it contains your tunnel token)

### Step 2: Install cloudflared on Synology

**Option A: Docker (Recommended)**

In Synology DSM:
1. Open **Container Manager** → **Image** → Pull `cloudflare/cloudflared:latest`
2. Create container with:
   - Command: `tunnel --no-autoupdate run`
   - Environment: `TUNNEL_TOKEN=<your-token-from-dashboard>`
   - Network: Host mode

**Option B: SSH**

```bash
# SSH into your Synology
sudo wget -O /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
sudo chmod +x /usr/local/bin/cloudflared

# Run the tunnel (replace YOUR_TOKEN)
sudo cloudflared service install YOUR_TOKEN
```

### Step 3: Configure Public Hostnames

In the Cloudflare Dashboard → your tunnel → **Public Hostname** tab, add:

| Service | Subdomain | Type | URL |
|---------|-----------|------|-----|
| DSM Web | `nas.awesomemm.com` | HTTP | `http://localhost:5000` |
| DSM HTTPS | `nas.awesomemm.com` | HTTPS | `https://localhost:5001` |
| File Station | `files.awesomemm.com` | HTTP | `http://localhost:5000` |

### Step 4: Update DDNS Worker

The DDNS worker can now point to your tunnel IP. When Synology updates its DDNS, the tunnel handles the routing:

1. Synology thinks it has a public IP (Cloudflare gives it one via the tunnel)
2. DDNS record updates to Cloudflare's IP
3. Traffic flows through the tunnel to your NAS

**Alternative: Skip DDNS entirely**

If you only need remote access (not DDNS), Cloudflare Tunnel is enough. Just:
- Create the tunnel
- Set public hostnames
- Access `nas.awesomemm.com` from anywhere

No DDNS needed because the tunnel IP never changes.

### Step 5: Secure with Cloudflare Access (Optional)

Add authentication to your exposed services:
1. Go to **Zero Trust** → **Access** → **Applications**
2. Create an application for `nas.awesomemm.com`
3. Add a policy (e.g., email-based OTP, or your Google/GitHub account)

This protects your NAS even if someone guesses the URL.

## Management Dashboard

A web-based management interface is included. Access it at:

```
https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/admin
```

Login with:
- **Username:** `admin`
- **Password:** Your `ADMIN_PASSWORD` secret

The dashboard lets you:
- View all DNS A records in your zone
- Add new DDNS records
- Edit existing records (hostname + IP)
- Delete records
- See the Synology DDNS endpoint URL for quick setup

## API Endpoints

### DDNS Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/update?hostname=X&myip=Y` | GET | Update DNS record |
| `/nic/update?hostname=X&myip=Y` | GET | Synology-compatible update |
| `/nic/checkip` | GET | Returns your public IP |
| `/health` | GET | Health check (returns `ok`) |

### Admin API

All admin endpoints require Basic Auth with the `ADMIN_PASSWORD`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin` | GET | Management dashboard UI |
| `/api/records` | GET | List all A records |
| `/api/records` | POST | Create a new A record |
| `/api/records/:id` | PUT | Update an A record |
| `/api/records/:id` | DELETE | Delete an A record |

**Create record:**
```bash
curl -u "admin:ADMIN_PASSWORD" -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"nas.example.com","content":"1.2.3.4"}' \
  https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/api/records
```

**List records:**
```bash
curl -u "admin:ADMIN_PASSWORD" \
  https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/api/records
```

**Delete record:**
```bash
curl -u "admin:ADMIN_PASSWORD" -X DELETE \
  https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/api/records/RECORD_ID
```

## Authentication

The `/update` and `/nic/update` endpoints require Basic Auth:

```
Authorization: Basic base64(admin:YOUR_API_TOKEN)
```

Synology DSM sends this header automatically when you configure the username/password.

## Testing

Test with curl:

```bash
# Health check
curl https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/health

# Update (with Basic Auth)
curl -u "admin:YOUR_API_TOKEN" \
  "https://synology-ddns.YOUR_SUBDOMAIN.workers.dev/update?hostname=nas.example.com&myip=$(curl -s ifconfig.me)"
```

## Local Development

```bash
npx wrangler dev
```

## Environment Variables (Secrets)

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token with DNS permissions |
| `RECORD_NAME` | Full hostname to update (e.g., `nas.example.com`) |
| `ADMIN_PASSWORD` | Password for the management dashboard |

## Environment Variables (Vars)

| Var | Description |
|-----|-------------|
| `ZONE_ID` | Cloudflare Zone ID for your domain |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `badauth` | Wrong password or missing auth | Check API token in Synology settings |
| `fail updating` | API token lacks DNS permissions | Regenerate token with `Zone:DNS:Edit` scope |
| `fail creating` | Zone ID mismatch | Verify `ZONE_ID` in `wrangler.jsonc` |
| DNS not resolving | Record not created yet | Trigger a manual update from Synology or curl |

## License

MIT
