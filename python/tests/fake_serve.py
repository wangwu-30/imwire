import json
import sys
import time

mode = sys.argv[1]
if mode == "stderr":
    for i in range(5000):
        sys.stderr.write("log line %d %s\n" % (i, "x" * 80))
        sys.stderr.flush()
for line in sys.stdin:
    req = json.loads(line)
    if mode == "slow":
        time.sleep(0.5)
    if mode == "junk":
        sys.stdout.write("[info]: [ws] connected\n")
        sys.stdout.flush()
    if mode == "big":
        sys.stdout.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": {
                        "event": {
                            "type": "message",
                            "id": "big",
                            "ts": 1,
                            "chat": {"platform": "telegram", "accountId": "a", "chatId": "1", "kind": "dm"},
                            "from": {"platform": "telegram", "accountId": "a", "userId": "u"},
                            "messageId": "m",
                            "text": "y" * 100000,
                            "mentionsBot": True,
                        }
                    },
                }
            )
            + "\n"
        )
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": {"ok": True}}) + "\n")
    sys.stdout.flush()
