"""Check the actual Git upload contents without printing sensitive matches."""
import argparse
import ipaddress
import json
import os
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PRIVATE_DIRS={'.runtime','.venv','node_modules','dist','artifacts','__pycache__','.pytest_cache','test-results','playwright-report','blob-report','.codex','.idea','.vscode'}
PRIVATE_SUFFIXES={'.pyc','.sqlite','.db','.log','.pem','.key','.p12','.pfx','.docx','.doc','.pdf','.zip','.7z','.rar','.tsbuildinfo'}
RULES={
    'machine_path':re.compile(r'(?i)\b[A-Z]:[\\/]|(?<![\w/])/(?:Users|home)/[^/\s]+'),
    'private_key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'access_token':re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})'),
    'email':re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
    'url_credentials':re.compile(r'https?://[^\s/@"\']+:[^\s/@"\']+@'),
    'phone':re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)'),
    'identity_number':re.compile(r'(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)'),
}

def git(*args):
    return subprocess.check_output(['git',*args],cwd=ROOT)

def inspect_blob(name,blob):
    """Return finding labels and line numbers, never the matched values."""
    findings=[]
    path=Path(name)
    if set(path.parts)&PRIVATE_DIRS or path.suffix.lower() in PRIVATE_SUFFIXES or (path.name.startswith('.env') and name!='.env.example') or '-wal'==path.suffix or '-shm'==path.suffix:
        findings.append({'path':name,'kind':'private_file'})
    if path.name.startswith(('id_rsa','id_ed25519','history-study-backup','study-recovery-key')):
        findings.append({'path':name,'kind':'private_file'})
    if blob.startswith(b'SQLite format 3'):
        findings.append({'path':name,'kind':'database_contents'})
    # These three reviewed, generated app icons are the only binary source assets.
    if name in {'public/icon-192.png','public/icon-512.png','public/apple-touch-icon.png'} and blob.startswith(b'\x89PNG\r\n\x1a\n'):
        return findings
    try: text=blob.decode('utf-8-sig')
    except UnicodeDecodeError:
        return findings+[{'path':name,'kind':'unexpected_binary'}]
    if path.suffix=='.json':
        try:
            payload=json.loads(text)
            if isinstance(payload,dict) and payload.get('format') in {'history-study-v1','history-study-encrypted-v2','history-study-migration-v2'}:
                findings.append({'path':name,'kind':'study_backup'})
        except ValueError: pass
    generic_users={'root','admin','administrator','runner','node','study','user','system','postgres'}
    usernames={Path.home().name,os.getenv('USERNAME','')}
    user_patterns=[re.compile(r'(?<!\w)'+re.escape(term)+r'(?!\w)',re.I) for term in usernames if len(term)>3 and term.lower() not in generic_users]
    for number,line in enumerate(text.splitlines(),1):
        for kind,pattern in RULES.items():
            matches=list(pattern.finditer(line))
            if kind=='email':
                matches=[m for m in matches if not m.group().endswith('@users.noreply.github.com')]
            if matches: findings.append({'path':name,'line':number,'kind':kind})
        if any(p.search(line) for p in user_patterns):
            findings.append({'path':name,'line':number,'kind':'local_username'})
        for match in re.finditer(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])',line):
            try: address=ipaddress.ip_address(match.group())
            except ValueError: continue
            if not address.is_loopback and not address.is_unspecified:
                findings.append({'path':name,'line':number,'kind':'server_or_lan_address'})
    if name=='.env.example':
        values={}
        for line in text.splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key,value=line.split('=',1); values[key.strip()]=value.strip().strip("'\"")
        if any(values.get(k) for k in ['ACCESS_PASSWORD_HASH','SESSION_SECRET','AI_API_KEY']):
            findings.append({'path':name,'kind':'nonempty_example_secret'})
    return findings

def audit(staged=False):
    args=['diff','--cached','--name-only','--diff-filter=ACMR','-z'] if staged else ['ls-files','-z']
    names=[n.decode('utf-8') for n in git(*args).split(b'\0') if n]
    if not names: raise SystemExit('No Git files selected; stage the upload files first.')
    findings=[]
    for name in names:
        findings.extend(inspect_blob(name,git('show',':'+name)))
    result={'files_checked':len(names),'findings':findings}
    print(json.dumps(result,ensure_ascii=True))
    if findings: raise SystemExit(1)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--staged',action='store_true')
    audit(parser.parse_args().staged)
