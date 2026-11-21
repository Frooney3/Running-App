"""Bundle the app into one self-contained HTML file (for hosting as a Claude artifact).

Usage: python3 build_single.py OUTPUT.html
"""
import re, sys, pathlib

root = pathlib.Path(__file__).parent
html = (root / 'index.html').read_text()
body = re.search(r'<body>(.*?)\s*<script src="plan.js">', html, re.S).group(1)
css = (root / 'styles.css').read_text()
plan = (root / 'plan.js').read_text()
app = (root / 'app.js').read_text()

out = f"""<title>Stride</title>
<style>
:root {{ color-scheme: dark; }}
{css}
</style>
{body}
<script>
{plan}
</script>
<script>
{app}
</script>
"""
pathlib.Path(sys.argv[1]).write_text(out)
print('wrote', sys.argv[1], len(out), 'bytes')
