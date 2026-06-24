import os
import re
import json

def find_chinese_strings(directory):
    chinese_pattern = re.compile(r'[\u4e00-\u9fff]+')
    results = set()
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith(('.js', '.html', '.css', '.json')) and not file.startswith('i18n_script'):
                path = os.path.join(root, file)
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    
                    if file.endswith('.json'):
                        try:
                            data = json.loads(content)
                            def extract_json_strings(obj):
                                if isinstance(obj, dict):
                                    for k, v in obj.items():
                                        extract_json_strings(k)
                                        extract_json_strings(v)
                                elif isinstance(obj, list):
                                    for item in obj:
                                        extract_json_strings(item)
                                elif isinstance(obj, str):
                                    if chinese_pattern.search(obj):
                                        results.add(obj)
                            extract_json_strings(data)
                        except:
                            pass
                    else:
                        # Extract strings from HTML text nodes and attributes, and JS strings
                        # For simplicity, let's just find lines with Chinese and extract the string literals or text nodes
                        for line in content.split('\n'):
                            if chinese_pattern.search(line):
                                # extract double quoted strings, single quoted strings, backtick strings, or HTML text between > and <
                                strings = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"|\'([^\'\\]*(?:\\.[^\'\\]*)*)\'|`([^`\\]*(?:\\.[^`\\]*)*)`|>([^<]*[\u4e00-\u9fff]+[^<]*)<', line)
                                for match in strings:
                                    for group in match:
                                        if group and chinese_pattern.search(group):
                                            results.add(group.strip())
    
    return list(results)

res = find_chinese_strings('.')
print(json.dumps(res, ensure_ascii=False, indent=2))
