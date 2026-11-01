import socket, json, sys, time
sock_path, token, content = sys.argv[1], sys.argv[2], sys.argv[3]
extra = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
msg = {"type": "user", "message": {"role": "user", "content": content}}
msg.update(extra)
s.sendall((json.dumps({"type": "auth", "token": token}) + "\n" + json.dumps(msg) + "\n").encode())
s.settimeout(3)
try:
    data = s.recv(65536)
    print("reply:", data.decode(errors="replace"))
except socket.timeout:
    print("no reply within 3s")
s.close()
