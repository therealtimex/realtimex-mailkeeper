"use strict";

/**
 * Minimal plaintext IMAP server for offline tests of the Himalaya credential
 * path. It accepts one synthetic login and answers CAPABILITY, LIST and
 * LOGOUT. With `messages: <n>` it also serves a read-only folder of n
 * synthetic messages (SELECT/EXAMINE, SEARCH and FETCH), for listing tests.
 * It records each command verb and whether the login matched, never the
 * credential itself.
 *
 *   mode "ok"   — greet and serve
 *   mode "hang" — accept the TCP connection and never greet (timeout case)
 */

const net = require("net");

function startImapStub({ user, password, mode = "ok", folders = ["INBOX", "Archive"], messages, onEvent } = {}) {
  const log = [];
  const record = (event) => {
    log.push(event);
    if (onEvent) onEvent(event);
  };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "hang") return;
    let buffer = Buffer.alloc(0);
    let pending = null; // { tag, verb, parts, need }
    let authenticated = false;

    const send = (line) => socket.write(`${line}\r\n`);
    send("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] MailKeeper test stub ready");

    const tokens = (line) => {
      const out = [];
      const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
      let match;
      while ((match = re.exec(line))) out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
      return out;
    };

    const finish = (tag, verb, args) => {
      record({ verb });
      switch (verb) {
        case "CAPABILITY":
          send("* CAPABILITY IMAP4rev1 AUTH=PLAIN");
          return send(`${tag} OK CAPABILITY completed`);
        case "LOGIN": {
          const ok = args[0] === user && args[1] === password;
          record({ login: ok ? "accepted" : "rejected" });
          if (ok) authenticated = true;
          return send(ok ? `${tag} OK LOGIN completed` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
        case "ID":
          send("* ID NIL");
          return send(`${tag} OK ID completed`);
        case "ENABLE":
        case "NOOP":
          return send(`${tag} OK ${verb} completed`);
        case "LIST":
          if (!authenticated) return send(`${tag} NO not authenticated`);
          for (const name of folders) send(`* LIST (\\HasNoChildren) "/" "${name}"`);
          return send(`${tag} OK LIST completed`);
        case "SELECT":
        case "EXAMINE":
          if (!authenticated || messages === undefined) return send(`${tag} BAD unsupported in test stub`);
          send("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)");
          send(`* ${messages} EXISTS`);
          send("* 0 RECENT");
          send("* OK [UIDVALIDITY 777] synthetic");
          send(`* OK [UIDNEXT ${messages + 101}] synthetic`);
          return send(`${tag} OK [READ-ONLY] selected`);
        case "SEARCH":
        case "FETCH":
        case "UID": {
          if (!authenticated || messages === undefined) return send(`${tag} BAD unsupported in test stub`);
          const sub = verb === "UID" ? String(args[0]).toUpperCase() : verb;
          const all = Array.from({ length: messages }, (_, i) => i + 1);
          if (sub === "SEARCH" || sub === "SORT") {
            send(`* ${sub} ${all.map((n) => (verb === "UID" ? n + 100 : n)).join(" ")}`.trim());
            return send(`${tag} OK ${sub} completed`);
          }
          if (sub !== "FETCH") return send(`${tag} BAD unsupported in test stub`);
          const set = String(args[verb === "UID" ? 1 : 0] || "");
          record({ verb: `${verb} FETCH`, set });
          const top = verb === "UID" ? messages + 100 : messages;
          const inSet = (n) =>
            set.split(",").some((part) => {
              const range = part.split(":").map((x) => (x === "*" ? top : Number(x)));
              return range.length === 1 ? n === range[0] : n >= Math.min(...range) && n <= Math.max(...range);
            });
          for (const n of all) {
            const uid = n + 100;
            if (!inSet(verb === "UID" ? uid : n)) continue;
            const headers = `Date: 1 Oct 2026 12:00:00 +0000\r\nFrom: Fixture <sender${n}@example.test>\r\nSubject: Fixture ${uid}\r\n\r\n`;
            socket.write(`* ${n} FETCH (UID ${uid} FLAGS () BODY[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID)] {${Buffer.byteLength(headers)}}\r\n${headers})\r\n`);
          }
          return send(`${tag} OK FETCH completed`);
        }
        case "LOGOUT":
          send("* BYE logging out");
          send(`${tag} OK LOGOUT completed`);
          return socket.end();
        default:
          return send(`${tag} BAD unsupported in test stub`);
      }
    };

    const handleLine = (line) => {
      const literal = /\{(\d+)(\+?)\}$/.exec(line);
      if (literal) {
        const head = line.slice(0, literal.index);
        if (!pending) {
          const [tag, verb, ...parts] = tokens(head);
          pending = { tag, verb: String(verb || "").toUpperCase(), parts };
        } else {
          pending.parts.push(...tokens(head));
        }
        pending.need = Number(literal[1]);
        if (!literal[2]) send("+ go ahead");
        return;
      }
      if (pending) {
        pending.parts.push(...tokens(line));
        const { tag, verb, parts } = pending;
        pending = null;
        return finish(tag, verb, parts);
      }
      const [tag, verb, ...parts] = tokens(line);
      if (tag && verb) finish(tag, String(verb).toUpperCase(), parts);
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pending && pending.need !== undefined && pending.need !== null) {
          if (buffer.length < pending.need) return;
          pending.parts.push(buffer.subarray(0, pending.need).toString("utf8"));
          buffer = buffer.subarray(pending.need);
          pending.need = null;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        handleLine(line);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        log,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startImapStub };

if (require.main === module) {
  // Standalone use for manual rehearsal: credentials come from the
  // environment so they never appear in argv.
  // realtimex-plugin-validator: allow-process-env -- test fixture only; not shipped in the plugin package.
  const env = process.env;
  const onEvent = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  startImapStub({ user: env.STUB_USER, password: env.STUB_PASSWORD, mode: env.STUB_MODE || "ok", onEvent }).then((stub) => {
    process.stdout.write(`${JSON.stringify({ port: stub.port })}\n`);
  });
}
