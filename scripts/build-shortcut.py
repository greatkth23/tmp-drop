"""Credential-free OS 27 uploader draft. Requires Apple signing and iPhone testing.
Action serialization reference: viticci/shortcuts-playground-plugin Apple-derived catalogs.
"""
import json
import plistlib
import uuid
from pathlib import Path

ORIGIN = 'https://drop.rmarkfcl.workers.dev'
A = []

def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'tmp-drop/shortcut/v1/' + name)).upper()

def add(kind, name, **p):
    A.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + kind,
              'WFWorkflowActionParameters': {'UUID': uid(name), **p}})
    return {'Type': 'ActionOutput', 'OutputUUID': uid(name), 'OutputName': name}

def var(name, coerce=None):
    v = {'Type': 'Variable', 'VariableName': name}
    if coerce:
        v['Aggrandizements'] = [{'Type': 'WFCoercionVariableAggrandizement', 'CoercionItemClass': coerce}]
    return v

def ref(v):
    return {'Value': v, 'WFSerializationType': 'WFTextTokenAttachment'}

def txt(*parts):
    s, attachments = '', {}
    for p in parts:
        if isinstance(p, dict):
            attachments['{%d, 1}' % (len(s.encode('utf-16-le')) // 2)] = p
            s += '\ufffc'
        else:
            s += str(p)
    v = {'string': s}
    if attachments:
        v['attachmentsByRange'] = attachments
    return {'Value': v, 'WFSerializationType': 'WFTextTokenString'}

def table(entries):
    return {'Value': {'WFDictionaryFieldValueItems': [
        {'WFKey': txt(k), 'WFItemType': t, 'WFValue': v} for k, t, v in entries
    ]}, 'WFSerializationType': 'WFDictionaryFieldValue'}

def start(name, v, code, literal=None):
    p = {'GroupingIdentifier': uid(name), 'WFControlFlowMode': 0, 'WFCondition': code,
         'WFInput': {'Type': 'Variable', 'Variable': ref(v)}}
    if literal is not None:
        p['WFNumberValue' if code in (0, 1, 2, 3) else 'WFConditionalActionString'] = str(literal)
    add('conditional', name + ' start', **p)

def end(name):
    add('conditional', name + ' end', GroupingIdentifier=uid(name), WFControlFlowMode=2)

def stop(name, message):
    add('alert', name + ' alert', WFAlertActionTitle='Temporary Drop',
        WFAlertActionMessage=message, WFAlertActionCancelButtonShown=False)
    add('exit', name + ' stop')

def key(source, k, name):
    return add('getvalueforkey', name, WFInput=ref(source), WFDictionaryKey=k, WFGetDictionaryValueType='Value')

def check_error(source, name):
    error = key(source, 'error', name + ' error')
    start(name, error, 100)
    message = key(error, 'message', name + ' message')
    stop(name, txt(message))
    end(name)

add('comment', 'Setup instructions', WFCommentActionText='iOS 27 draft. Paste your upload-only token in the next Text action. Never share a personalized copy. Share files/photos to run. Retention: 24 hours. No background guarantee.')
token = add('gettext', 'Upload-only token', WFTextActionText='')
valid_token = add('text.match', 'Validate token', text=txt(token), WFMatchTextPattern='^[A-Za-z0-9_-]{43}$', WFMatchTextCaseSensitive=True)
start('Missing token', valid_token, 101)
stop('Missing token', '먼저 내 기기에서 업로드 전용 토큰을 발급하고 단축어의 첫 번째 텍스트 액션에 붙여 넣으세요.')
end('Missing token')
retention = add('number', 'Retention seconds', WFNumberActionNumber='86400')
shared = {'Type': 'ExtensionInput'}
start('Missing files', shared, 101)
stop('Missing files', '파일 또는 사진 앱에서 선택한 뒤 공유 → Temporary Drop을 실행하세요.')
end('Missing files')
add('repeat.each', 'Each file start', GroupingIdentifier=uid('Each file'), WFControlFlowMode=0, WFInput=ref(shared))
file = var('Repeat Item', 'WFFileContentItem')
size = add('properties.files', 'File size', WFInput=ref(file), WFContentItemPropertyName='File Size')
size['Aggrandizements'] = [{'Type': 'WFCoercionVariableAggrandizement', 'CoercionItemClass': 'WFNumberContentItem'}]
start('Empty file', size, 1, 0)
stop('Empty file', '빈 파일은 올릴 수 없습니다.')
end('Empty file')
start('Too large', size, 2, 5 * 1024 ** 3)
stop('Too large', '이 경로의 API 상한은 5 GiB입니다. 작은 파일로 먼저 시험해 주세요.')
end('Too large')
filename = add('getitemname', 'Filename', WFInput=ref(file))
nonce = [add('number.random', 'Request nonce ' + str(i), WFRandomNumberMinimum=1, WFRandomNumberMaximum=2147483647) for i in range(3)]
created = add('downloadurl', 'Create upload', WFURL=ORIGIN + '/api/shortcut/uploads', WFHTTPMethod='POST', WFHTTPBodyType='JSON',
    WFHTTPHeaders=table([('Authorization', 0, txt('Bearer ', token)), ('Idempotency-Key', 0, txt('ios-', nonce[0], '-', nonce[1], '-', nonce[2])), ('Content-Type', 0, txt('application/json'))]),
    WFJSONValues=table([('filename', 0, txt(filename)), ('sizeBytes', 1, txt(size)), ('mime', 0, txt('application/octet-stream')), ('retentionSeconds', 1, txt(retention))]))
check_error(created, 'Create failed')
file_id = key(created, 'id', 'Upload ID')
capability = key(created, 'capability', 'Upload capability')
put_url = key(created, 'putUrl', 'Presigned PUT URL')
for name, value in [('Missing ID', file_id), ('Missing capability', capability), ('Missing URL', put_url)]:
    start(name, value, 101)
    stop(name, '업로드 응답을 확인할 수 없습니다. 완료로 표시하지 않고 중단합니다.')
    end(name)
# Production putHeaders is {}. Neither credential belongs in an R2 request.
add('downloadurl', 'PUT original file', WFURL=txt(put_url), WFHTTPMethod='PUT', WFHTTPBodyType='File', WFRequestVariable=ref(file), WFHTTPHeaders=table([]), WFFormValues=table([]))
headers = table([('Authorization', 0, txt('Upload ', capability)), ('Content-Type', 0, txt('application/json'))])
complete = add('downloadurl', 'Complete upload', WFURL=txt(ORIGIN + '/api/uploads/', file_id, '/complete'), WFHTTPMethod='POST', WFHTTPBodyType='JSON', WFHTTPHeaders=headers, WFJSONValues=table([]))
check_error(complete, 'Complete failed')
state = key(complete, 'state', 'Completed state')
add('setvariable', 'Set state', WFVariableName='File state', WFInput=ref(state))
add('repeat.count', 'Poll start', GroupingIdentifier=uid('Poll'), WFControlFlowMode=0, WFRepeatCount=20)
start('Finalizing', var('File state'), 4, 'FINALIZING')
add('delay', 'Poll delay', WFDelayTime=3)
status = add('downloadurl', 'Upload status', WFURL=txt(ORIGIN + '/api/uploads/', file_id), WFHTTPMethod='GET', WFHTTPHeaders=headers)
check_error(status, 'Status failed')
polled = key(status, 'state', 'Polled state')
add('setvariable', 'Update state', WFVariableName='File state', WFInput=ref(polled))
end('Finalizing')
add('repeat.count', 'Poll end', GroupingIdentifier=uid('Poll'), WFControlFlowMode=2)
start('Not ready', var('File state'), 5, 'READY')
stop('Not ready', txt('완료를 확인하지 못했습니다. 현재 상태: ', var('File state'), '. 파일 받기에서 확인한 뒤 다시 시도하세요.'))
end('Not ready')
add('notification', 'Confirmed completion', WFNotificationActionTitle='Temporary Drop', WFNotificationActionBody=txt(filename, ' 업로드 완료 · 파일 받기에서 확인하세요.'), WFNotificationActionSound=False)
add('repeat.each', 'Each file end', GroupingIdentifier=uid('Each file'), WFControlFlowMode=2)

workflow = {'WFWorkflowName': 'Temporary Drop', 'WFWorkflowClientVersion': '2700.0.4', 'WFWorkflowClientRelease': '27.0.1',
    'WFWorkflowMinimumClientVersion': 900, 'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 61440, 'WFWorkflowIconStartColor': 431817727},
    'WFWorkflowTypes': ['ActionExtension'], 'WFWorkflowHasOutputFallback': False, 'WFWorkflowImportQuestions': [],
    'WFWorkflowInputContentItemClasses': ['WFGenericFileContentItem', 'WFImageContentItem'],
    'WFWorkflowOutputContentItemClasses': [], 'WFWorkflowActions': A}

def validate():
    seen, groups = set(), []
    def walk(v):
        if isinstance(v, dict):
            if v.get('Type') == 'ActionOutput':
                assert v['OutputUUID'] in seen, 'Missing/forward reference'
            if v.get('WFSerializationType') == 'WFTextTokenString':
                s = v['Value']['string']
                indexes = [len(s[:i].encode('utf-16-le')) // 2 for i, c in enumerate(s) if c == '\ufffc']
                assert set(v['Value'].get('attachmentsByRange', {})) == {'{%d, 1}' % i for i in indexes}
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    for a in A:
        p = a['WFWorkflowActionParameters']
        walk(p)
        assert p['UUID'] not in seen
        seen.add(p['UUID'])
        if 'WFControlFlowMode' in p:
            if p['WFControlFlowMode'] == 0:
                groups.append(p['GroupingIdentifier'])
            else:
                assert groups.pop() == p['GroupingIdentifier']
    assert not groups
    assert A[1]['WFWorkflowActionParameters']['WFTextActionText'] == ''
    p = next(a['WFWorkflowActionParameters'] for a in A if a['WFWorkflowActionParameters'].get('WFHTTPMethod') == 'PUT')
    assert p['WFHTTPBodyType'] == 'File' and p['WFHTTPHeaders'] == table([])

if __name__ == '__main__':
    validate()
    out = Path('.wrangler/shortcuts')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'Temporary-Drop-unsigned.shortcut').write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
    (out / 'Temporary-Drop.source.plist').write_bytes(plistlib.dumps(workflow))
    report = {'actions': len(A), 'sourceValidated': True, 'signed': False, 'iPhoneTested': False, 'target': 'iOS 27.0.1', 'origin': ORIGIN}
    (out / 'validation.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
