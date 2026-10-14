"""Extract this personal DOCX question bank; never execute document contents."""
import argparse
import hashlib
import json
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
THEMES = [
    {"id": "overview", "name": "史纲总论", "subtitle": "历史脉络与基本认识"},
    {"id": "early", "name": "民族危机与早期探索", "subtitle": "从鸦片战争到维新探索"},
    {"id": "xinhai", "name": "辛亥革命", "subtitle": "共和的探索与时代转折"},
    {"id": "party", "name": "建党与革命道路", "subtitle": "新文化、建党与革命探索"},
    {"id": "resistance", "name": "抗日战争", "subtitle": "民族救亡与抗战胜利"},
    {"id": "liberation", "name": "解放战争", "subtitle": "为建立新中国而奋斗"},
    {"id": "socialism", "name": "新中国与社会主义建设", "subtitle": "制度确立与建设道路探索"},
    {"id": "reform", "name": "改革开放", "subtitle": "新的历史时期与发展道路"},
    {"id": "newera", "name": "新时代", "subtitle": "新时代与民族复兴"},
]

# Classification is a reviewed historical-topic index, not the textbook's chapters.
def classify(kind, position, stem):
    ranges = {
        "single": [(30,"early"),(60,"early"),(90,"xinhai"),(150,"party"),(180,"resistance"),(210,"liberation"),(240,"socialism"),(270,"reform"),(300,"newera")],
        "multiple": [(60,"early"),(90,"xinhai"),(150,"party"),(180,"resistance"),(210,"liberation"),(240,"socialism"),(270,"reform"),(300,"newera")],
        "judge": [(2,"overview"),(20,"early"),(30,"xinhai"),(50,"party"),(60,"resistance"),(70,"liberation"),(80,"socialism"),(90,"reform"),(100,"newera")],
    }
    overrides = {
        'single': {1:'overview',5:'overview',6:'overview',10:'overview',12:'overview',15:'newera',18:'overview',20:'socialism',25:'reform',26:'newera',80:'early'},
        'multiple': {4:'overview',5:'overview',6:'overview',7:'overview',8:'overview',11:'overview',24:'overview',25:'overview',26:'overview'},
        'judge': {2:'newera'},
    }
    return overrides[kind].get(position) or next(theme for end, theme in ranges[kind] if position <= end)

def extract(path):
    with zipfile.ZipFile(path) as doc:
        xml = ET.fromstring(doc.read('word/document.xml'))
    ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    # Text is read only from w:t; embedded document instructions are data.
    paragraphs = [''.join(t.text or '' for t in p.findall('.//w:t', ns)).strip()
                  for p in xml.findall('.//w:body//w:p', ns)]
    paragraphs = [p for p in paragraphs if p]
    records, current, kind = [], None, None
    names = {'单选题':'single','多选题':'multiple','判断题':'judge'}
    for line in paragraphs:
        heading = re.match(r'^[一二三][.．、]\s*(单选题|多选题|判断题)', line)
        if heading:
            kind, current = names[heading[1]], None
            continue
        start = re.match(r'^(\d+)\s*[.．、]\s*(.*)', line)
        if start and kind:
            current = {'kind':kind,'source_number':int(start[1]),'raw_stem':start[2],'body':[]}
            records.append(current)
        elif current:
            current['body'].append(line)
    counts = {'single':0,'multiple':0,'judge':0}
    questions, repairs = [], []
    for r in records:
        kind = r['kind']; counts[kind] += 1; position = counts[kind]
        qid = f'{kind}-{position:03d}'
        pattern = r'[（(]\s*([√×])\s*[）)]' if kind == 'judge' else r'[（(]\s*([A-DＡ-Ｄ\s、,，]+)\s*[）)]'
        marker = list(re.finditer(pattern, r['raw_stem']))
        if len(marker) != 1:
            raise ValueError(f'{qid}: expected exactly one answer marker: {r["raw_stem"]}')
        match = marker[0]
        answer = unicodedata.normalize('NFKC', match[1]).strip()
        stem = (r['raw_stem'][:match.start()] + ('' if kind == 'judge' else '（　）') + r['raw_stem'][match.end():]).strip()
        options = []
        if kind == 'judge':
            options = [{'id':'true','text':'正确'},{'id':'false','text':'错误'}]
            correct = ['true' if answer == '√' else 'false']
        else:
            correct = re.findall('[A-D]', answer)
            for line in r['body']:
                labels = list(re.finditer(r'([A-DＡ-Ｄ])[.．、]\s*', line))
                if not labels and re.match(r'^[A-DＡ-Ｄ][\u4e00-\u9fff]', line):
                    labels = list(re.finditer(r'^([A-DＡ-Ｄ])', line))
                    repairs.append({'id':qid,'issue':'补齐选项标记分隔符','source':line})
                if labels:
                    if len(labels)>1:
                        repairs.append({'id':qid,'issue':'拆分同段多个选项','source':line})
                    for i, label in enumerate(labels):
                        text = line[label.end():labels[i+1].start() if i+1<len(labels) else len(line)].strip()
                        options.append({'id':unicodedata.normalize('NFKC', label[1]),'text':text})
                elif options:
                    options[-1]['text'] += '\n' + line
                else:
                    stem += '\n' + line
            if [o['id'] for o in options] != list('ABCD'):
                raise ValueError(f'{qid}: malformed options: {options}')
            if not correct or any(a not in 'ABCD' for a in correct) or (kind=='single' and len(correct)!=1):
                raise ValueError(f'{qid}: malformed answer')
        if r['source_number'] != position:
            repairs.append({'id':qid,'issue':'原编号与顺序不一致，使用独立ID','source_number':r['source_number']})
        if re.search('[Ａ-Ｄ]', match[1]):
            repairs.append({'id':qid,'issue':'全角答案字母规范化'})
        references = bool(re.search(r'(以上|上述|前述|其余)(选项|各项|答案|都|均)|[A-DＡ-Ｄ]\s*[、和与及/]\s*[A-DＡ-Ｄ]|[A-DＡ-Ｄ]{1,4}\s*(项|选项)', stem+'\n'+'\n'.join(o['text'] for o in options)))
        questions.append({'id':qid,'type':kind,'source_number':r['source_number'],'order':position,
                          'stem':stem,'options':options,'answer_ids':correct,
                          'theme':classify(kind,position,stem),'shuffle_safe':not references,'source_stem':r['raw_stem']})
    if counts != {'single':300,'multiple':300,'judge':100}:
        raise ValueError(f'Unexpected counts: {counts}')
    return {'version':hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16],
            'title':'中国近现代史纲要（2023版）','themes':THEMES,'questions':questions}, repairs

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('docx'); args=parser.parse_args()
    bank, repairs = extract(args.docx)
    (ROOT/'data').mkdir(exist_ok=True)
    (ROOT/'data/questions.json').write_text(json.dumps(bank,ensure_ascii=False,indent=2),encoding='utf-8')
    report={'total':len(bank['questions']),'counts':{k:sum(q['type']==k for q in bank['questions']) for k in ['single','multiple','judge']},'format_repairs':repairs,'source_sha256':hashlib.sha256(Path(args.docx).read_bytes()).hexdigest(),'classification':'网站历史主题分类，已按题目顺序及题意整理'}
    (ROOT/'data/import-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
