import sys, json
from graphify.extract import collect_files, extract
from pathlib import Path

code_files = []
detect = json.loads(Path('graphify-out/.graphify_detect.json').read_text(encoding='utf-8'))
for f in detect.get('files', {}).get('code', []):
    code_files.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])

if code_files:
    result = extract(code_files, cache_root=Path('.'))
    with open('graphify-out/.graphify_ast.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f'AST: {len(result["nodes"])} nodes, {len(result["edges"])} edges')
else:
    with open('graphify-out/.graphify_ast.json', 'w', encoding='utf-8') as f:
        json.dump({'nodes':[],'edges':[],'input_tokens':0,'output_tokens':0}, f, ensure_ascii=False)
    print('No code files - skipping AST extraction')
