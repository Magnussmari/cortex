/**
 * TC-4e (review FIX-FIRST) — a REAL mTLS-enforcing HTTPS server, run as a Node
 * subprocess by the cloud-publisher wire test.
 *
 * Why a Node subprocess and not an in-process server: Bun 1.3.2's `node:https`
 * server does NOT implement client-cert verification — it neither enforces
 * `requestCert`/`rejectUnauthorized` nor exposes `socket.getPeerCertificate()`.
 * So an in-process (Bun-hosted) server cannot observe whether the client
 * presented a certificate. Node's `https` server DOES both. Running the server
 * under Node faithfully reproduces production: the Cloudflare Worker is a real
 * mTLS-enforcing endpoint, and this proves Bun's `fetch` (the client) presents
 * the client cert TO such a server.
 *
 * Protocol: reads cert paths + behaviour from argv/env, prints `PORT=<n>` on
 * stdout once listening, and for every request prints one JSON line on stdout:
 *   {"path": "...", "clientCN": "<CN|null>", "authorized": <bool>}
 * The test parses these lines to assert the client cert reached the wire.
 *
 * NON-SECRET: only ever loaded with throwaway test fixtures.
 */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const caPath = process.env.CA_PATH;
const certPath = process.env.SERVER_CERT_PATH;
const keyPath = process.env.SERVER_KEY_PATH;

const server = createServer(
  {
    cert: readFileSync(certPath, "utf-8"),
    key: readFileSync(keyPath, "utf-8"),
    ca: readFileSync(caPath, "utf-8"),
    requestCert: true,
    // Enforce: a client that presents no cert (or an untrusted one) is
    // rejected at the handshake. NO skip-verify anywhere.
    rejectUnauthorized: true,
  },
  (req, res) => {
    const sock = req.socket;
    const peer = typeof sock.getPeerCertificate === "function" ? sock.getPeerCertificate() : {};
    const cn = peer && peer.subject && typeof peer.subject.CN === "string" ? peer.subject.CN : null;
    process.stdout.write(
      JSON.stringify({ path: req.url, clientCN: cn, authorized: sock.authorized }) + "\n",
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  },
);

// A no-client-cert handshake against requestCert+rejectUnauthorized surfaces
// here — the request never reaches the handler. Record it so the test can see
// that a cert-less client is genuinely rejected.
server.on("tlsClientError", (err) => {
  process.stdout.write(JSON.stringify({ tlsClientError: err.message }) + "\n");
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stdout.write(`PORT=${port}\n`);
});

// Exit cleanly when the parent closes stdin.
process.stdin.on("end", () => server.close(() => process.exit(0)));
process.stdin.resume();
