"""Native masked frame -> real capture store -> processor -> timeline read model.
Only the model gateway is a mock. Uses only this run's generated public evidence.
"""
import base64, json, sqlite3, sys
from pathlib import Path
from datetime import datetime
from uuid import uuid4
from app.modules.context_engine.capture import CaptureSettings, CaptureStore, MaskedObservation, init_capture_store
from app.modules.context_engine.audit import init_privacy_audit
from app.modules.context_engine.processor import ObservationProcessor
from app.modules.model_gateway.gateway import CallAuthorization

root=Path(__file__).resolve().parents[2]/'data'/'windows-native-evidence'
payload=json.loads((root/'native-payload.json').read_text())
settings=json.loads((root/'native-configure.json').read_text())
now=datetime.fromisoformat(payload['captured_at'].replace('Z','+00:00'))
class ClosingConnection(sqlite3.Connection):
    def __exit__(self,*args):
        try:return super().__exit__(*args)
        finally:self.close()
owned=root/'timeline-runs'/str(uuid4());owned.mkdir(parents=True)
db=lambda:sqlite3.connect(owned/'timeline-owned.sqlite3',factory=ClosingConnection)
with db() as conn:init_privacy_audit(conn);init_capture_store(conn)
store=CaptureStore(db,owned,lambda:'strict',lambda:now)
revision=store.configure(CaptureSettings(**settings))['consent_revision'];store.start()
payload['consent_revision']=revision
result=store.ingest(MaskedObservation(**payload))
class MockGateway:
    configuration_revision=1
    def __init__(self):self.calls=[]
    def status(self):return type('Status',(),{'ready':True})()
    def call_text(self,prompt,auth,**options):
        options['dispatch_precondition']();self.calls.append('text')
        return json.dumps({'title':'Public synthetic window','summary':'Public test text is visible; the shopping line was masked.',
            'boundary':'Mock understanding; actual Windows capture and offline OCR only.',
            'comparison':{'performed':False,'prior_observation_ids':[],'current_quote':'','prior_quote':''}})
    def call_image(self,*args,**kwargs):raise AssertionError('OCR mode must not call image model')
gateway=MockGateway();auth=CallAuthorization(privacy_mode='strict',authorized=True,redacted=True)
processor=ObservationProcessor(store,gateway,lambda:auth)
assert processor.process(result['id'],base64.b64decode(payload['masked_png_base64']))
rows=store.list_records();row=next(r for r in rows if r['id']==result['id'])
assert row['state']=='ready' and row['extraction_version']==2
assert row['provenance']['capture_method']=='windows_wgc_hwnd'
assert row['provenance']['source_identity']==payload['source_identity']
assert row['current_facts']['image_digest']==payload['post_mask_ocr_image_digest']
assert store.evidence(row['evidence_id'])==base64.b64decode(payload['masked_png_base64'])
assert 'post_mask_ocr_text' not in row
store.pause()
evidence={'status':'passed','timeline_record':row,'model_calls':gateway.calls,
          'model_understanding':'mock only; real semantic quality not accepted',
          'evidence_traceable':True,'real_native_window_and_masking_and_offline_ocr':True}
(root/'timeline-result.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'status':'passed','record_id':row['id'],'state':row['state'],'extraction_version':row['extraction_version'],'capture_method':row['provenance']['capture_method'],'model_calls':gateway.calls}))
