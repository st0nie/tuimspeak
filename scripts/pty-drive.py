"""Drive tuimspeak in a pseudo-terminal and print its screen (docs/development.md).

Runs a command in a pty of the given size, renders the output with the pyte
VT emulator, and replays mouse and key input, so the real app (Ink, mouse
layer, dialogs) can be checked end to end without a person at a terminal.

usage: uv run --with pyte scripts/pty-drive.py COLS ROWS 'command args' -- action...

actions:
  wait S              read output for S seconds
  dump [LABEL]        print the screen
  find TEXT           print where TEXT is on screen
  click X Y | dclick X Y | rclick X Y | press X Y | release X Y   (0-based cells)
  wheel up|down X Y
  key TEXT            send keys; Python escapes allowed, e.g. "key \x1b[B" or "key \r"

At exit it reports which mouse modes were enabled and whether mouse tracking
was turned off again (architecture §5.4, §6.1).
"""
import fcntl, os, pty, select, struct, sys, termios, time
import pyte

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[3].split()
actions = sys.argv[5:] if sys.argv[4] == "--" else sys.argv[4:]

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.kill(pid, 28)  # SIGWINCH

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
raw = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return
        r, _, _ = select.select([fd], [], [], left)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            raw.extend(data)
            stream.feed(data)


def send(s):
    os.write(fd, s.encode() if isinstance(s, str) else s)
    pump(0.25)


def mouse(b, x, y, final):
    send(f"\x1b[<{b};{x + 1};{y + 1}{final}")


def dump(label=""):
    print(f"----- screen {label} -----")
    for i, line in enumerate(screen.display):
        print(f"{i:2d}|{line.rstrip()}")


pump(2.5)
i = 0
while i < len(actions):
    a = actions[i].split(" ", 1)
    name, arg = a[0], (a[1] if len(a) > 1 else "")
    p = arg.split()
    if name == "wait":
        pump(float(arg))
    elif name == "dump":
        dump(arg)
    elif name == "click":
        mouse(0, int(p[0]), int(p[1]), "M"); mouse(0, int(p[0]), int(p[1]), "m")
    elif name == "dclick":
        x, y = int(p[0]) + 1, int(p[1]) + 1
        send(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m" * 2)
    elif name == "rclick":
        mouse(2, int(p[0]), int(p[1]), "M"); mouse(2, int(p[0]), int(p[1]), "m")
    elif name == "press":
        mouse(0, int(p[0]), int(p[1]), "M")
    elif name == "release":
        mouse(0, int(p[0]), int(p[1]), "m")
    elif name == "wheel":
        mouse(64 if p[0] == "up" else 65, int(p[1]), int(p[2]), "M")
    elif name == "key":
        send(arg.encode().decode("unicode_escape").encode("utf-8") if "\\" in arg else arg)
    elif name == "find":
        for y, line in enumerate(screen.display):
            x = line.find(arg)
            if x >= 0:
                print(f"find {arg!r}: x={x} y={y}")
                break
        else:
            print(f"find {arg!r}: not found")
    i += 1

modes = {m: (m.encode() in raw) for m in ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1006h", "\x1b[?1004h", "\x1b[?1049h"]}
print("modes enabled:", {k.replace("\x1b", "ESC"): v for k, v in modes.items()})
send("\x11")  # Ctrl+Q
pump(1.5)
tail = bytes(raw[-200:])
print("mouse off at exit:", b"\x1b[?1000l" in raw)
try:
    wpid, status = os.waitpid(pid, os.WNOHANG)
    print("exited:", wpid != 0, "status", status)
except ChildProcessError:
    print("exited: True")
