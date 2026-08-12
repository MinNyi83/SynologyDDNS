export interface Env {
  CF_API_TOKEN: string;
  ZONE_ID: string;
  RECORD_NAME: string;
}

interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
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

    if (path === "/health") {
      return new Response("ok");
    }

    if (path === "/nic/update" || path === "/update") {
      return handleUpdate(request, env);
    }

    if (path === "/nic/checkip" || path === "/checkip") {
      return new Response(request.headers.get("cf-connecting-ip") || "unknown");
    }

    return new Response("Synology DDNS Worker\n\nEndpoints:\n  /update?hostname=sub.example.com&myip=1.2.3.4\n  /nic/update?hostname=sub.example.com&myip=1.2.3.4\n  /checkip\n  /health\n", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

async function handleUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.searchParams.get("hostname") || url.searchParams.get("host");
  const myip = url.searchParams.get("myip") || url.searchParams.get("ip");

  if (!hostname || !myip) {
    return plainText("badauth", 401);
  }

  const authHeader = request.headers.get("Authorization");
  const basicAuth = authHeader?.startsWith("Basic ")
    ? atob(authHeader.slice(6))
    : null;

  if (basicAuth) {
    const [user, pass] = basicAuth.split(":");
    if (pass !== env.CF_API_TOKEN) {
      return plainText("badauth", 401);
    }
  }

  try {
    const cfApiBase = `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/dns_records`;

    const listResp = await fetch(
      `${cfApiBase}?type=A&name=${encodeURIComponent(hostname)}`,
      {
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const listData: CloudflareResponse<DNSRecord[]> = await listResp.json();

    if (!listData.success) {
      return plainText("badauth", 500);
    }

    const existing = listData.result.find(
      (r) => r.type === "A" && r.name === hostname
    );

    if (existing) {
      if (existing.content === myip) {
        return plainText("good " + myip);
      }

      const updateResp = await fetch(`${cfApiBase}/${existing.id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "A",
          name: hostname,
          content: myip,
          ttl: 1,
          proxied: false,
        }),
      });

      const updateData: CloudflareResponse<DNSRecord> = await updateResp.json();

      if (!updateData.success) {
        return plainText("fail updating", 500);
      }

      return plainText("good " + myip);
    }

    const createResp = await fetch(cfApiBase, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "A",
        name: hostname,
        content: myip,
        ttl: 1,
        proxied: false,
      }),
    });

    const createData: CloudflareResponse<DNSRecord> = await createResp.json();

    if (!createData.success) {
      return plainText("fail creating", 500);
    }

    return plainText("good " + myip);
  } catch (err) {
    return plainText("fail " + (err instanceof Error ? err.message : "unknown"), 500);
  }
}

function plainText(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
