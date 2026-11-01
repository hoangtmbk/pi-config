import sys, json, os, threading, time
INBOX = sys.argv[1]
LOG = INBOX + ".log"
lock = threading.Lock()
def send(obj):
    with lock:
        sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
def log(s):
    with open(LOG, "a") as f: f.write(time.strftime("%T ") + s + "\n")
def poll():
    while True:
        if os.path.exists(INBOX):
            txt = open(INBOX).read().strip(); os.remove(INBOX)
            send({"jsonrpc": "2.0", "method": "notifications/claude/channel", "params": {"content": txt, "meta": {"from": "lead"}}})
            log("pushed: " + txt)
        time.sleep(0.5)
threading.Thread(target=poll, daemon=True).start()
for line in sys.stdin:
    try: msg = json.loads(line)
    except Exception: continue
    log("recv: " + line.strip()[:200])
    m, i = msg.get("method"), msg.get("id")
    if m == "initialize":
        send({"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
              "serverInfo": {"name": "wfchan", "version": "0.1.0"},
              "capabilities": {"tools": {}, "experimental": {"claude/channel": {}}},
              "instructions": "Events from the Lead arrive as <channel source=\"wfchan\">. Act on them."}})
    elif m == "tools/list":
        send({"jsonrpc": "2.0", "id": i, "result": {"tools": []}})
    elif i is not None:
        send({"jsonrpc": "2.0", "id": i, "result": {}})
