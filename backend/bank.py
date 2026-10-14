import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BANK=json.loads((ROOT/'data/questions.json').read_text(encoding='utf-8'))
QUESTIONS={q['id']:q for q in BANK['questions']}
THEME_ORDER={t['id']:i for i,t in enumerate(BANK['themes'])}
TITLES={'full':'通刷模式','paper80':'80题随机卷','paper20':'20题小卷','category':'分类练习','review':'错题与不确定题','favorites':'收藏练习'}
DEFAULT_PREFS={'auto_next':False,'shuffle_options':False,'reduce_repeats':False}
