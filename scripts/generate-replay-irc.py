#!/usr/bin/env python3
"""
Generate an mIRC-style HTML replay of an ensemble collab session.
Classic IRC look: channel bar, nicklist, timestamps, colored nicks.
Usage: python3 generate-replay-irc.py <team-id> [--task "desc"] [--output replay.html]
"""

import json
import os
import sys
import html
import re
from datetime import datetime

def load_messages(team_id):
    path = f"/tmp/ensemble/{team_id}/messages.jsonl"
    if not os.path.isfile(path):
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(1)
    msgs = []
    with open(path) as f:
        for line in f:
            if line.strip():
                try:
                    msgs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return msgs

# Classic mIRC nick colors
NICK_COLORS = {
    "codex": "#5B9BD5",    # blue
    "claude": "#70C770",   # green
    "gemini": "#E5C07B",   # yellow/gold
    "aider": "#C678DD",    # purple
    "ensemble": "#888899", # gray
}

def get_nick_color(name):
    for key, color in NICK_COLORS.items():
        if key in name.lower():
            return color
    return "#CC6666"  # default red


def format_irc_content(text):
    """Format message content for IRC display."""
    text = html.escape(text)
    # Bold **text**
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    # Severity tags get colored
    text = re.sub(r'\[(CRITICAL)\]', r'<span class="sev-critical">[\1]</span>', text)
    text = re.sub(r'\[(HIGH)\]', r'<span class="sev-high">[\1]</span>', text)
    text = re.sub(r'\[(MEDIUM)\]', r'<span class="sev-medium">[\1]</span>', text)
    text = re.sub(r'\[(LOW)\]', r'<span class="sev-low">[\1]</span>', text)
    text = re.sub(r'\[(INFO)\]', r'<span class="sev-info">[\1]</span>', text)
    # Newlines
    text = text.replace('\n', '<br>')
    return text


def generate_html(msgs, team_id, task):
    agents = {}
    first_ts = ""
    last_ts = ""

    for m in msgs:
        sender = m.get("from", "")
        if sender and sender != "ensemble":
            if sender not in agents:
                agents[sender] = {"count": 0, "color": get_nick_color(sender)}
            agents[sender]["count"] += 1
        if not first_ts and m.get("timestamp"):
            first_ts = m["timestamp"]
        if m.get("timestamp"):
            last_ts = m["timestamp"]

    total_msgs = sum(a["count"] for a in agents.values())

    duration = ""
    if first_ts and last_ts:
        try:
            t1 = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
            t2 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            secs = int((t2 - t1).total_seconds())
            mins = secs // 60
            duration = f"{mins}m {secs % 60}s" if mins else f"{secs}s"
        except Exception:
            pass

    # Channel name
    channel = f"#ensemble-collab"

    # Build nicklist HTML
    nicklist_html = ""
    for name, info in agents.items():
        prefix = "@" if info == list(agents.values())[0] else "+"
        nicklist_html += f'<div class="nick" style="color:{info["color"]}">{prefix}{html.escape(name)}</div>\n'

    # Build messages HTML
    messages_html = ""

    # Join messages
    for name in agents:
        color = agents[name]["color"]
        messages_html += f'<div class="line join">* <span class="nick-ref" style="color:{color}">{html.escape(name)}</span> has joined {channel}</div>\n'

    # Topic set
    messages_html += f'<div class="line topic">* Topic for {channel}: {html.escape(task[:200])}</div>\n'
    messages_html += f'<div class="line separator">---</div>\n'

    for m in msgs:
        sender = m.get("from", "unknown")
        content = m.get("content", "")
        ts = m.get("timestamp", "")

        if sender == "ensemble":
            continue

        time_str = ""
        if ts:
            try:
                t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                time_str = t.strftime("%H:%M")
            except Exception:
                pass

        color = get_nick_color(sender)
        formatted = format_irc_content(content)

        # Pad nick to 12 chars for alignment (visual only)
        messages_html += f'<div class="line msg"><span class="time">[{time_str}]</span> <span class="nick-ref" style="color:{color}">&lt;{html.escape(sender)}&gt;</span> {formatted}</div>\n'

    # Part messages
    for name in agents:
        color = agents[name]["color"]
        messages_html += f'<div class="line part">* <span class="nick-ref" style="color:{color}">{html.escape(name)}</span> has left {channel} (audit complete)</div>\n'

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mIRC — {channel}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
    font-family: 'Segoe UI', Tahoma, sans-serif;
    font-size: 13px;
    background: #008080;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 20px;
}}

/* Win98 Window */
.window {{
    width: 100%;
    max-width: 1100px;
    height: 90vh;
    border: 2px outset #dfdfdf;
    background: #c0c0c0;
    display: flex;
    flex-direction: column;
    box-shadow: 4px 4px 0px rgba(0,0,0,0.3);
}}

/* Title bar */
.titlebar {{
    background: linear-gradient(90deg, #000080 0%, #1084d0 100%);
    padding: 3px 4px;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    cursor: default;
    -webkit-user-select: none;
}}
.titlebar-icon {{
    width: 16px;
    height: 16px;
    background: #FFD700;
    border-radius: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: bold;
    color: #000080;
}}
.titlebar-text {{
    flex: 1;
    color: white;
    font-size: 12px;
    font-weight: bold;
    white-space: nowrap;
    overflow: hidden;
}}
.titlebar-btn {{
    width: 16px;
    height: 14px;
    background: #c0c0c0;
    border: 1px outset #dfdfdf;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: bold;
    cursor: default;
    font-family: 'Marlett', sans-serif;
}}

/* Menu bar */
.menubar {{
    background: #c0c0c0;
    border-bottom: 1px solid #808080;
    padding: 2px 4px;
    display: flex;
    gap: 2px;
    flex-shrink: 0;
}}
.menu-item {{
    padding: 1px 8px;
    font-size: 12px;
    color: #000;
    cursor: default;
}}
.menu-item:hover {{
    background: #000080;
    color: white;
}}

/* Toolbar */
.toolbar98 {{
    background: #c0c0c0;
    border-bottom: 1px solid #808080;
    padding: 2px 4px;
    display: flex;
    gap: 2px;
    align-items: center;
    flex-shrink: 0;
}}
.tool-btn {{
    border: 1px outset #dfdfdf;
    background: #c0c0c0;
    padding: 1px 4px;
    font-size: 14px;
    cursor: default;
    min-width: 24px;
    text-align: center;
}}
.tool-sep {{
    width: 2px;
    height: 20px;
    border-left: 1px solid #808080;
    border-right: 1px solid #ffffff;
    margin: 0 2px;
}}

/* Channel tab strip */
.tabstrip {{
    background: #c0c0c0;
    padding: 0 4px;
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid #808080;
}}
.tab {{
    border: 1px outset #dfdfdf;
    border-bottom: none;
    padding: 2px 12px;
    font-size: 11px;
    cursor: default;
    margin-right: 1px;
}}
.tab.active {{
    background: white;
    border-bottom: 1px solid white;
    font-weight: bold;
    position: relative;
    top: 1px;
}}

/* Main area */
.client {{
    display: flex;
    flex: 1;
    overflow: hidden;
    background: white;
    border: 2px inset #dfdfdf;
    margin: 2px;
}}

/* Chat */
.chat {{
    flex: 1;
    overflow-y: auto;
    padding: 4px 6px;
    font-family: 'Fixedsys', 'Lucida Console', 'Consolas', monospace;
    font-size: 13px;
    background: white;
    color: #000;
}}
.line {{ line-height: 1.5; word-break: break-word; }}
.line.msg:hover {{ background: #EEF; }}
.time {{ color: #808080; }}
.nick-ref {{ font-weight: bold; }}
.line.join {{ color: #009300; }}
.line.part {{ color: #930000; }}
.line.topic {{ color: #000093; }}
.line.separator {{ color: #c0c0c0; text-align: center; font-size: 11px; margin: 2px 0; }}

.sev-critical {{ color: #CC0000; font-weight: bold; }}
.sev-high {{ color: #CC6600; font-weight: bold; }}
.sev-medium {{ color: #999900; }}
.sev-low {{ color: #009900; }}
.sev-info {{ color: #0066CC; }}
.line b {{ color: #000; }}

/* Nicklist */
.nicklist {{
    width: 140px;
    background: white;
    border-left: 2px inset #dfdfdf;
    padding: 4px;
    overflow-y: auto;
    font-family: 'Fixedsys', 'Lucida Console', 'Consolas', monospace;
    font-size: 12px;
}}
.nicklist .nick {{ padding: 0; cursor: default; }}

/* Input */
.inputbar {{
    background: #c0c0c0;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}}
.input-nick {{
    font-size: 12px;
    font-weight: bold;
    color: #000;
}}
.input-field {{
    flex: 1;
    border: 2px inset #dfdfdf;
    padding: 2px 4px;
    font-family: 'Fixedsys', 'Lucida Console', 'Consolas', monospace;
    font-size: 12px;
    background: white;
    color: #808080;
}}

/* Statusbar */
.statusbar {{
    background: #c0c0c0;
    border-top: 1px solid #808080;
    padding: 1px 4px;
    display: flex;
    font-size: 11px;
    color: #000;
    flex-shrink: 0;
}}
.status-cell {{
    border: 1px inset #dfdfdf;
    padding: 0 6px;
    margin-right: 2px;
}}

/* Scrollbar - classic look */
.chat::-webkit-scrollbar {{ width: 16px; }}
.chat::-webkit-scrollbar-track {{ background: #c0c0c0; border: 1px inset #dfdfdf; }}
.chat::-webkit-scrollbar-thumb {{ background: #c0c0c0; border: 2px outset #dfdfdf; }}
.chat::-webkit-scrollbar-button {{ background: #c0c0c0; border: 1px outset #dfdfdf; height: 16px; }}

@media (max-width: 640px) {{
    .nicklist {{ display: none; }}
    body {{ padding: 0; }}
    .window {{ height: 100vh; max-width: 100%; border: none; box-shadow: none; }}
}}
</style>
</head>
<body>

<div class="window">
    <div class="titlebar">
        <div class="titlebar-icon">m</div>
        <span class="titlebar-text">mIRC — {channel} — {html.escape(task[:80])}</span>
        <div class="titlebar-btn">_</div>
        <div class="titlebar-btn">□</div>
        <div class="titlebar-btn">✕</div>
    </div>

    <div class="menubar">
        <span class="menu-item"><u>F</u>ile</span>
        <span class="menu-item"><u>V</u>iew</span>
        <span class="menu-item">F<u>a</u>vorites</span>
        <span class="menu-item"><u>T</u>ools</span>
        <span class="menu-item"><u>W</u>indow</span>
        <span class="menu-item"><u>H</u>elp</span>
    </div>

    <div class="toolbar98">
        <span class="tool-btn">📎</span>
        <span class="tool-btn">📁</span>
        <span class="tool-sep"></span>
        <span class="tool-btn">🔗</span>
        <span class="tool-btn">⚙️</span>
        <span class="tool-sep"></span>
        <span class="tool-btn">🎨</span>
        <span class="tool-btn">👤</span>
        <span class="tool-sep"></span>
        <span style="font-size:11px;color:#000;margin-left:8px;">ensemble v1.0</span>
    </div>

    <div class="tabstrip">
        <div class="tab">Status</div>
        <div class="tab active">{channel}</div>
    </div>

    <div class="client">
        <div class="chat" id="chat">
            <div class="line topic">* Now talking in <b style="color:#000093">{channel}</b></div>
            <div class="line topic">* Topic is: {html.escape(task[:200])}</div>
            <div class="line topic">* Set by <b style="color:#000093">ensemble</b></div>
            <div class="line separator">—————————————————————————————————</div>
            {messages_html}
        </div>
        <div class="nicklist">
            {nicklist_html}
        </div>
    </div>

    <div class="inputbar">
        <span class="input-nick">[spectator]</span>
        <input class="input-field" value="This is a replay — {total_msgs} messages, {duration}" readonly>
    </div>

    <div class="statusbar">
        <span class="status-cell">{channel}</span>
        <span class="status-cell">{len(agents)} users</span>
        <span class="status-cell">{total_msgs} msgs</span>
        <span class="status-cell">{duration}</span>
        <span class="status-cell" style="flex:1;text-align:right;"><a href="https://github.com/michelhelsdingen/ensemble" style="color:#000093;text-decoration:none;">github.com/michelhelsdingen/ensemble</a></span>
    </div>
</div>

</body>
</html>'''


def main():
    if len(sys.argv) < 2:
        print("Usage: generate-replay-irc.py <team-id> [--task 'desc'] [--output file.html]", file=sys.stderr)
        sys.exit(1)

    team_id = sys.argv[1]
    output = "replay-irc.html"
    task = "Ensemble Collaboration Session"

    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output = sys.argv[idx + 1]

    if "--task" in sys.argv:
        idx = sys.argv.index("--task")
        if idx + 1 < len(sys.argv):
            task = sys.argv[idx + 1]

    # Try API
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://localhost:23000/api/ensemble/teams/{team_id}", timeout=2) as resp:
            team_data = json.loads(resp.read())
            api_task = team_data.get("team", {}).get("description", "")
            if api_task:
                task = api_task
    except Exception:
        pass

    msgs = load_messages(team_id)
    if not msgs:
        print("No messages found", file=sys.stderr)
        sys.exit(1)

    html_content = generate_html(msgs, team_id, task)

    with open(output, "w") as f:
        f.write(html_content)

    agent_count = len(set(m.get("from") for m in msgs if m.get("from") != "ensemble"))
    msg_count = len([m for m in msgs if m.get("from") != "ensemble"])
    print(f"✓ Generated {output} ({msg_count} messages, {agent_count} agents) — mIRC style")


if __name__ == "__main__":
    main()
