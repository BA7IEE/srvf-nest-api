from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit
from urllib.request import urlopen
import hashlib
class Entry(HTMLParser):
 def handle_starttag(self,tag,attrs):
  src=dict(attrs).get('src')
  if tag=='script' and src and src.startswith('/static/js/'):
   url=urljoin('https://dp.srvf.team/',src)
   assert urlsplit(url).netloc=='dp.srvf.team'
   with urlopen(url,timeout=15) as res:
    print('bundle',src,res.status,hashlib.sha256(res.read()).hexdigest())
with urlopen('https://dp.srvf.team/',timeout=15) as res:
 html=res.read().decode()
 print('root',res.status,'title_srvf', '<title>SRVF运营系统</title>' in html)
 Entry().feed(html)
