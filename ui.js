// UI glue: tower buttons, hotkeys, save/load, controls

(function(){
  const towerMap = {
    basic:'basic', sniper:'sniper', rapid:'rapid', heavy:'heavy',
    poison:'poison', frost:'frost', tesla:'tesla', mortar:'mortar'
  };

  window.__UI = { selectedTowerId: 'basic' };

  function buildTowerButtons(){
    const list = document.getElementById('towerList');
    list.innerHTML = '';
    const defs = ['basic','sniper','rapid','heavy','poison','frost','tesla','mortar'];
    defs.forEach((id,idx)=>{
      const el = document.createElement('div');
      el.className = 'tower-btn';
      el.dataset.type = id;
      el.innerHTML = `<div style="width:18px;height:18px;border-radius:4px;background:${getColor(id)}"></div>
                      <div style="flex:1">
                        <div style="font-weight:700">${idx+1}. ${capitalize(id)}</div>
                        <div class="small">cost: ? dmg: ?</div>
                      </div>`;
      el.addEventListener('click', ()=> selectTower(id) );
      list.appendChild(el);
    });
    updateSelectedUI();
  }

  function getColor(id){
    const map = { basic:'#4A90E2', sniper:'#8A54FF', rapid:'#FF9F43', heavy:'#2B6BA3', poison:'#4CAF50', frost:'#39A0ED', tesla:'#FFD54F', mortar:'#A16EFF' };
    return map[id] || '#888';
  }
  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  function selectTower(id){
    window.__UI.selectedTowerId = id;
    updateSelectedUI();
  }

  function updateSelectedUI(){
    document.getElementById('selectedInfo').textContent = 'Selected: ' + capitalize(window.__UI.selectedTowerId);
    const btns = document.querySelectorAll('.tower-btn');
    btns.forEach(b => b.classList.toggle('selected', b.dataset.type === window.__UI.selectedTowerId));
  }

  // hook controls
  document.getElementById('collectAll').addEventListener('click', ()=>{ window.__GAME.collectAllPowerups(); });
  document.getElementById('sendWaves').addEventListener('click', ()=>{ const n = parseInt(document.getElementById('sendCount').value || 1); window.__GAME.sendMultipleWaves(n); });
  document.getElementById('fastForward').addEventListener('click', ()=>{ window.__GAME.toggleFast(); });

  document.getElementById('btn-save').addEventListener('click', ()=> {
    try{
      const s = window.__GAME.getState();
      localStorage.setItem('td_save', JSON.stringify({ gold: s.gold, wave: s.wave, lives: s.lives, score: s.score }));
      alert('Saved');
    } catch(err){ alert('Save failed'); }
  });
  document.getElementById('btn-load').addEventListener('click', ()=> {
    try{
      const v = localStorage.getItem('td_save');
      if(v){
        const data = JSON.parse(v);
        alert('Loaded: ' + JSON.stringify(data));
      } else alert('No save found');
    } catch(err){ alert('Load failed'); }
  });
  document.getElementById('btn-reset').addEventListener('click', ()=> { if(confirm('Reset game?')) location.reload(); });

  // hotkeys
  window.addEventListener('keydown', (e) => {
    if(['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8'].includes(e.code)){
      const idx = parseInt(e.code.slice(-1),10)-1;
      const defs = ['basic','sniper','rapid','heavy','poison','frost','tesla','mortar'];
      if(defs[idx]) selectTower(defs[idx]);
    }
    if(e.code === 'Space'){ window.__GAME.spawnWave(); }
  });

  // init
  buildTowerButtons();
  updateSelectedUI();

})();
