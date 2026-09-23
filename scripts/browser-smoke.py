from playwright.sync_api import sync_playwright
from pathlib import Path
import json
r=Path(__file__).resolve().parents[1]
report={'checks':[], 'errors':[]}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 page=b.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
 page.on('pageerror',lambda e:report['errors'].append(str(e)))
 page.clock.install()
 # Render the already-read HTML bytes; no file:// or local URL navigation.
 page.set_content((r/'svoi-preview.html').read_text(),wait_until='load')
 page.locator('#create-room').click()
 assert page.locator('#game').is_visible()
 assert page.locator('#auto-status').inner_text()=='Автораздача включена'
 assert not page.locator('#start-hand').is_visible()
 report['checks'].append('Demo starts once; manual next-hand button hidden')
 # Wait for the first real hero action, not a test-only API.
 for i in range(25):
  if not page.locator('#fold').is_disabled(): break
  page.clock.run_for(1000)
 assert not page.locator('#fold').is_disabled()
 page.locator('#fold').click()
 for i in range(70):
  if 'Следующая раздача через' in page.locator('#auto-status').inner_text():break
  page.clock.run_for(500)
 assert 'Следующая раздача через' in page.locator('#auto-status').inner_text()
 first=page.locator('#hand-counter').inner_text()
 page.screenshot(path=str(r/'docs/autodeal-mobile-v0.3.png'),full_page=True)
 page.locator('#pause-table').click()
 assert page.locator('#auto-status').inner_text()=='Стол на паузе'
 page.clock.run_for(12000)
 assert page.locator('#hand-counter').inner_text()==first
 page.locator('#pause-table').click()
 page.clock.run_for(6500)
 assert page.locator('#hand-counter').inner_text()!=first, page.locator('#auto-status').inner_text()
 assert page.locator('#settlement-button').is_visible()
 report['checks'].append('Automatic next hand; pause/resume; prior settlement survives rollover')
 page.locator('#settlement-button').click()
 assert 'Разбор раздачи #1' in page.locator('#modal-content').inner_text()
 page.locator('#close-modal').click()
 # Let the hero action clock expire; other seats remain automatic demo bots.
 for i in range(40):
  if not page.locator('#fold').is_disabled():break
  page.clock.run_for(500)
 assert not page.locator('#fold').is_disabled()
 page.clock.run_for(30500)
 assert page.locator('#participation-button').inner_text()=='Я вернулся'
 assert 'Не играю' in page.locator('#participation-note').inner_text() or 'Автопас' in page.locator('#participation-note').inner_text()
 page.screenshot(path=str(r/'docs/sitout-mobile-v0.3.png'),full_page=True)
 report['checks'].append('Action timeout shows sit-out and explicit return control')
 page.locator('#participation-button').click()
 assert page.locator('#participation-button').inner_text()=='Отменить возвращение'
 assert page.locator('#playing-actions').is_hidden()
 page.locator('#participation-button').click()
 assert page.locator('#participation-button').inner_text()=='Я вернулся'
 report['checks'].append('Return is queued, current hand stays inactive; queue can be cancelled')
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
 report['checks'].append('No horizontal overflow at 390px')
 page.set_viewport_size({'width':1440,'height':1000})
 page.screenshot(path=str(r/'docs/sitout-desktop-v0.3.png'),full_page=True)
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
 report['checks'].append('Desktop layout at 1440px')
 report['errors']=list(dict.fromkeys(report['errors']))
 assert not report['errors'],report['errors']
 b.close()
(r/'docs/browser-report-v0.3.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
