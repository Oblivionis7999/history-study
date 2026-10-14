"""Create a portable source package without local state or credentials."""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FILES=['.env.example','.gitignore','.dockerignore','Dockerfile','compose.yaml','package.json','package-lock.json',
       'tsconfig.json','vite.config.ts','index.html','playwright.config.ts','README.md','PLAN.md','TEST_REPORT.md','start-local.ps1','LICENSE','.gitattributes']
FOLDERS=['backend','src','data','scripts','tests','deploy','dist']

def package():
    output=ROOT/'artifacts/history-study-deploy.zip'; output.parent.mkdir(exist_ok=True)
    files=[ROOT/p for p in FILES]
    for folder in FOLDERS:
        files += [p for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix not in {'.pyc','.tsbuildinfo'}]
    files += sorted((ROOT/'artifacts/screenshots').glob('*.png'))
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for p in sorted(set(files)):
            if not p.is_file(): raise FileNotFoundError(p)
            archive.write(p,'history-study/'+p.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        names=archive.namelist()
        assert not any(set(Path(name).parts)&{'.env','.runtime','.venv','node_modules','__pycache__'} for name in names)
        assert len(json.loads(archive.read('history-study/data/questions.json'))['questions'])==700
    sha=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.sha256').write_text(sha+'  '+output.name+'\n',encoding='ascii')
    print(json.dumps({'path':str(output),'bytes':output.stat().st_size,'files':len(files),'sha256':sha}))

if __name__=='__main__': package()
