import math

def validate_records(records, questions, bank_version, modes, prefs):
    """Validate the whole snapshot before replacing any live records."""
    def require(condition):
        if not condition: raise ValueError('Invalid backup')

    def number(value):
        return type(value) in {int,float} and math.isfinite(value)

    def selected(qid, values):
        require(isinstance(values,list) and all(isinstance(v,str) for v in values))
        require(len(values)==len(set(values)) and set(values)<=set(o['id'] for o in questions[qid]['options']))
        require(questions[qid]['type']=='multiple' or len(values)<=1)

    require(isinstance(records,dict) and set(records)=={'session','state','chat','cache','prefs'})
    for kind,items in records.items():
        require(isinstance(items,list))
        ids=set()
        for item in items:
            require(isinstance(item,dict) and isinstance(item.get('id'),str) and 0<len(item['id'])<128)
            require(item['id'] not in ids); ids.add(item['id'])
            if kind=='state':
                require(item['id'] in questions)
                require(all(type(item.get(key)) is bool for key in ['favorite','uncertain','wrong','mastered','disputed']))
                require(isinstance(item.get('note'),str) and len(item['note'])<=12000)
                require('first_correct' not in item or type(item['first_correct']) is bool)
                require('last_answered' not in item or number(item['last_answered']))
            elif kind=='prefs':
                require(item['id']=='main' and all(type(item.get(key)) is bool for key in prefs))
            elif kind=='session':
                require(item.get('mode') in modes and isinstance(item.get('title'),str) and number(item.get('created_at')))
                require(item.get('bank_version')==bank_version)
                qids=item.get('question_ids')
                require(isinstance(qids,list) and 0<len(qids)<=len(questions) and all(isinstance(q,str) and q in questions for q in qids))
                require(len(qids)==len(set(qids)))
                require(type(item.get('cursor')) is int and 0<=item['cursor']<len(qids))
                require(item.get('feedback') in {'immediate','test'} and item.get('status') in {'active','completed'})
                require(item['feedback']!='test' or item['mode'] in {'paper20','paper80'})
                require(isinstance(item.get('option_orders'),dict) and set(item['option_orders'])==set(qids))
                for qid in qids:
                    order=item['option_orders'][qid]
                    selected(qid,order) if questions[qid]['type']=='multiple' else require(isinstance(order,list))
                    require(len(order)==len(set(order)) and set(order)==set(o['id'] for o in questions[qid]['options']))
                    if not questions[qid]['shuffle_safe'] or questions[qid]['type']=='judge':
                        require(order==[o['id'] for o in questions[qid]['options']])
                require(isinstance(item.get('drafts'),dict) and set(item['drafts'])<=set(qids))
                for qid,values in item['drafts'].items(): selected(qid,values)
                require(isinstance(item.get('results'),dict) and set(item['results'])<=set(qids))
                for qid,result in item['results'].items():
                    require(isinstance(result,dict)); selected(qid,result.get('selected'))
                    require(bool(result['selected']) and number(result.get('answered_at')))
                    require(result.get('correct_ids')==questions[qid]['answer_ids'])
                    require(type(result.get('correct')) is bool and result['correct']==(set(result['selected'])==set(questions[qid]['answer_ids'])))
                    require(item['drafts'].get(qid)==result['selected'])
                if item['feedback']=='test':
                    require(not item['results'] if item['status']=='active' else set(item['results'])=={q for q,v in item['drafts'].items() if v})
                elif item['status']=='completed':
                    require(len(item['results'])==len(qids))
            else:
                require(item.get('question_id') in questions)
                if kind=='chat':
                    require(item.get('channel') in {'hint','solution'} and item['id']==item['question_id']+':'+item['channel'])
                    require(isinstance(item.get('messages'),list))
                    for m in item['messages']:
                        require(isinstance(m,dict) and m.get('role') in {'user','assistant'} and isinstance(m.get('text'),str))
                        if 'options' in m:
                            require(isinstance(m['options'],list))
                            require(all(isinstance(o,dict) and all(isinstance(o.get(k),str) for k in ['id','label','text']) for o in m['options']))
                            q=questions[item['question_id']]
                            require(len(m['options'])==len(q['options']) and {o['id']:o['text'] for o in m['options']}=={o['id']:o['text'] for o in q['options']})
                else:
                    require(isinstance(item.get('text'),str) and isinstance(item.get('model'),str))
