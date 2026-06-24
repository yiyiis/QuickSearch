import re

with open('src/onboarding/onboarding.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Add script at the end before onboarding.js
content = content.replace('<script src="onboarding.js"></script>', '<script src="../../lib/i18n.js"></script>\n  <script src="onboarding.js"></script>')

# Find all Chinese text and wrap it or add data-i18n
# It's actually easier to just add data-i18n="text" to tags that contain ONLY text and some inline tags, but we have to be careful.
# Instead of a script, I will just output the exact replacement blocks using my tool.
