"""Extract the final JSON answer of a research subagent transcript (JSONL) into a file, without printing it."""
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
last = None
for line in open(src):
    try:
        m = json.loads(line)
    except Exception:
        continue
    msg = m.get('message') or {}
    if msg.get('role') != 'assistant':
        continue
    content = msg.get('content')
    texts = [c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text'] if isinstance(content, list) else [content or '']
    for t in texts:
        if '```json' in t or t.strip().startswith('[') or t.strip().startswith('{'):
            last = t
if last is None:
    sys.exit('no json answer found')
mm = re.search(r'```json\s*(.*?)```', last, re.S)
body = mm.group(1) if mm else last
data = json.loads(body)
json.dump(data, open(dst, 'w'), indent=1, ensure_ascii=False)
print('saved', dst, type(data).__name__, len(data))
