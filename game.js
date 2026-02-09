// Core game engine: towers, enemies, waves, power-ups
// This file is intentionally modular but single-file for game logic

(function(){
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Game state
  let state = {
    gold: 200,
    lives: 20,
    wave: 0,
    score: 0,
    playing: true,
    waveActive: false,
    timeScale: 1
  };

  // Exported for UI
  window.__GAME_STATE = state;

  // Collections
  const towers = [];
  const enemies = [];
  const projectiles = [];
  const powerups = [];
  const particles = [];

  // Paths (multiple maps) -> for simplicity one path used, but structure supports many
  const maps = [
    [ {x:-40,y:150},{x:160,y:150},{x:160,y:320},{x:420,y:320},{x:420,y:260},{x:700,y:260},{x:920,y:260} ]
  ];
  let currentMap = 0;
  const path = maps[currentMap];

  // Tower definitions
  const towerDefs = {
    basic:{id:'basic',name:'Basic',cost:60,range:120,fireRate:40,dmg:8,color:'#4A90E2'},
    sniper:{id:'sniper',name:'Sniper',cost:140,range:320,fireRate:100,dmg:48,color:'#8A54FF'},
    rapid:{id:'rapid',name:'Rapid',cost:100,range:100,fireRate:10,dmg:3,color:'#FF9F43'},
    heavy:{id:'heavy',name:'Heavy',cost:220,range:90,fireRate:110,dmg:120,color:'#2B6BA3'},
    poison:{id:'poison',name:'Poison',cost:150,range:110,fireRate:36,dmg:6,color:'#4CAF50'},
    frost:{id:'frost',name:'Frost',cost:150,range:110,fireRate:50,dmg:2,color:'#39A0ED'},
    tesla:{id:'tesla',name:'Tesla',cost:200,range:140,fireRate:30,dmg:18,color:'#FFD54F'},
    mortar:{id:'mortar',name:'Mortar',cost:260,range:250,fireRate:140,dmg:90,color:'#A16EFF'}
  };

  // Enemy presets
  const enemyPresets = {
    grunt:{hp:40,speed:1.2,color:'#FF6B6B',radius:12,score:10},
    shield:{hp:140,speed:0.7,color:'#ffd86b',radius:16,score:30},
    fast:{hp:24,speed:2.2,color:'#7ee787',radius:9,score:12},
    flyer:{hp:30,speed:2.0,color:'#7fb0ff',radius:10,score:14,flying:true},
    boss:{hp:1200,speed:0.45,color:'#8a54ff',radius:30,score:500}
  };

  // Classes
  class Enemy{
    constructor(type){
      Object.assign(this, type);
      this.maxHp = this.hp;
      this.pathIndex = 0;
      this.x = path[0].x;
      this.y = path[0].y;
      this.reached = false;
      this.slowTimer = 0;
      this.dot = 0;
      this.dotTimer = 0;
    }
    update(dt){
      if(this.slowTimer > 0){
        this.slowTimer -= dt;
        if(this.slowTimer < 0) this.slowTimer = 0;
      }
      const sp = (this.slowTimer > 0) ? this.speed * 0.45 : this.speed;
      if(this.pathIndex < path.length - 1){
        const target = path[this.pathIndex + 1];
        const dx = target.x - this.x;
        const dy = target.y - this.y;
        const d = Math.hypot(dx,dy);
        if(d < sp * dt){
          this.pathIndex++;
        } else {
          this.x += dx / d * sp * dt;
          this.y += dy / d * sp * dt;
        }
      } else {
        this.reached = true;
      }
    }
    draw(){
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      const w = this.radius * 2;
      ctx.fillStyle = '#000000aa';
      ctx.fillRect(this.x - this.radius, this.y - this.radius - 8, w, 4);
      ctx.fillStyle = '#7ee787';
      ctx.fillRect(this.x - this.radius, this.y - this.radius - 8, w * (this.hp / this.maxHp), 4);
      ctx.strokeStyle = '#00000055';
      ctx.strokeRect(this.x - this.radius, this.y - this.radius - 8, w, 4);
    }
  }

  class Tower{
    constructor(x,y,def){
      this.x = x;
      this.y = y;
      this.def = JSON.parse(JSON.stringify(def));
      this.baseId = def.id;
      this.level = 1;
      this.cool = 0;
    }
    upgrade(){
      const cost = Math.floor(this.def.cost * (1 + this.level * 0.7));
      if(state.gold >= cost){
        state.gold -= cost;
        this.level++;
        this.def.dmg = Math.round(this.def.dmg * 1.6);
        this.def.range = Math.round(this.def.range * 1.05);
        this.def.fireRate = Math.max(4, Math.floor(this.def.fireRate * 0.85));
        return true;
      }
      return false;
    }
    update(dt){
      this.cool -= dt * 60 * state.timeScale;
      if(this.cool <= 0){
        let target = null, best = -1;
        for(let e of enemies){
          const d = Math.hypot(e.x - this.x, e.y - this.y);
          if(d <= this.def.range){
            let prog = e.pathIndex + (Math.hypot(e.x - path[e.pathIndex].x, e.y - path[e.pathIndex].y) / 200);
            if(prog > best){ best = prog; target = e; }
          }
        }
        if(target){
          this.fire(target);
          this.cool = this.def.fireRate;
        }
      }
    }
    fire(target){
      // behavior per tower type
      switch(this.baseId){
        case 'poison': projectiles.push(new PoisonProjectile(this.x,this.y,target,this.def.dmg)); break;
        case 'frost':  projectiles.push(new SlowProjectile(this.x,this.y,target,this.def.dmg)); break;
        case 'mortar': projectiles.push(new AoEProjectile(this.x,this.y,target,this.def.dmg,18)); break;
        case 'tesla':  projectiles.push(new TeslaProjectile(this.x,this.y,target,this.def.dmg)); break;
        default:       projectiles.push(new Projectile(this.x,this.y,target,this.def.dmg)); break;
      }
    }
    draw(){
      ctx.strokeStyle = 'rgba(70,140,200,0.12)';
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.def.range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = this.def.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0008';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Lv' + this.level, this.x, this.y + 4);
    }
  }

  class Projectile{
    constructor(x,y,target,dmg){
      this.x = x; this.y = y; this.target = target; this.speed = 9; this.dmg = dmg; this.radius = 4; this.color = '#ffd93d';
    }
    update(dt){
      if(!this.target || this.target.reached) return false;
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx,dy);
      if(d < this.speed * dt){
        this.target.hp -= this.dmg;
        if(this.target.hp <= 0) killEnemy(this.target);
        return false;
      }
      this.x += dx / d * this.speed * dt;
      this.y += dy / d * this.speed * dt;
      return true;
    }
    draw(){
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  class PoisonProjectile extends Projectile{
    constructor(x,y,target,dmg){ super(x,y,target,dmg); this.color = '#8bc34a'; }
    update(dt){
      if(!this.target || this.target.reached) return false;
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx,dy);
      if(d < this.speed * dt){
        this.target.hp -= this.dmg;
        this.target.dot = (this.target.dot || 0) + 8;
        this.target.dotTimer = 8;
        if(this.target.hp <= 0) killEnemy(this.target);
        return false;
      }
      this.x += dx / d * this.speed * dt;
      this.y += dy / d * this.speed * dt;
      return true;
    }
  }

  class SlowProjectile extends Projectile{
    constructor(x,y,target,dmg){ super(x,y,target,dmg); this.color = '#39A0ED'; }
    update(dt){
      if(!this.target || this.target.reached) return false;
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx,dy);
      if(d < this.speed * dt){
        this.target.hp -= this.dmg;
        this.target.slowTimer = Math.max(this.target.slowTimer || 0, 120);
        if(this.target.hp <= 0) killEnemy(this.target);
        return false;
      }
      this.x += dx / d * this.speed * dt;
      this.y += dy / d * this.speed * dt;
      return true;
    }
  }

  class AoEProjectile extends Projectile{
    constructor(x,y,target,dmg,radius){ super(x,y,target,dmg); this.color = '#ff8a80'; this.radiusAoE = radius; }
    update(dt){
      if(!this.target || this.target.reached) return false;
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx,dy);
      if(d < this.speed * dt){
        // explode
        for(let i=enemies.length-1;i>=0;i--){
          const e = enemies[i];
          const dd = Math.hypot(e.x - this.target.x, e.y - this.target.y);
          if(dd <= this.radiusAoE){
            e.hp -= this.dmg;
            if(e.hp <= 0) killEnemy(e);
          }
        }
        return false;
      }
      this.x += dx / d * this.speed * dt;
      this.y += dy / d * this.speed * dt;
      return true;
    }
  }

  class TeslaProjectile extends Projectile{
    constructor(x,y,target,dmg){ super(x,y,target,dmg); this.color = '#fff176'; this.chain = 3; }
    update(dt){
      if(!this.target || this.target.reached) return false;
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const d = Math.hypot(dx,dy);
      if(d < this.speed * dt){
        this.target.hp -= this.dmg;
        if(this.target.hp <= 0) killEnemy(this.target);
        // chain to nearby
        let last = this.target;
        for(let c=0;c<this.chain;c++){
          let next = null; let best = 999999;
          for(let e of enemies){ if(e === last) continue; const dd = Math.hypot(e.x-last.x,e.y-last.y); if(dd < 80 && dd < best){ next = e; best = dd; } }
          if(next){ next.hp -= Math.floor(this.dmg * 0.6); if(next.hp <= 0) killEnemy(next); last = next; } else break;
        }
        return false;
      }
      this.x += dx / d * this.speed * dt;
      this.y += dy / d * this.speed * dt;
      return true;
    }
  }

  // Particles & Powerups
  class Particle{
    constructor(x,y,color){ this.x=x; this.y=y; this.vx=rand(-2,2); this.vy=rand(-2,2); this.life=rand(30,70); this.color=color; this.r=rand(1,3); }
    update(){ this.x += this.vx; this.y += this.vy; this.vy += 0.06; this.life--; }
    draw(){ ctx.fillStyle = this.color; ctx.beginPath(); ctx.arc(this.x,this.y,this.r,0,Math.PI*2); ctx.fill(); }
  }

  class PowerUp{
    constructor(x,y,kind){ this.x=x; this.y=y; this.kind=kind; this.radius=12; this.ttl=12*60; }
    update(){ this.ttl--; }
    draw(){
      ctx.fillStyle = '#ffffffdd';
      ctx.beginPath();
      ctx.arc(this.x,this.y,this.radius,0,Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      const label = {gold:'G',speed:'S',shield:'H',nuke:'N'}[this.kind] || '?';
      ctx.fillText(label, this.x, this.y + 4);
    }
  }

  // spawn, kill, collect
  function spawnWave(){
    state.wave++;
    document.getElementById('wave').textContent = state.wave;
    state.waveActive = true;
    const count = 6 + Math.floor(state.wave * 2.6);
    for(let i=0;i<count;i++){
      setTimeout(()=>{
        let t = enemyPresets.grunt;
        if(state.wave > 5 && Math.random() < 0.2) t = enemyPresets.shield;
        else if(state.wave > 2 && Math.random() < 0.25) t = enemyPresets.fast;
        enemies.push(new Enemy(Object.assign({}, t)));
      }, i * 420 / state.timeScale);
    }
    if(state.wave % 8 === 0){
      setTimeout(()=> enemies.push(new Enemy(Object.assign({}, enemyPresets.boss))), count * 420 / state.timeScale + 900);
    }
  }

  function sendMultipleWaves(n){
    n = Math.max(1, Math.floor(n));
    let delay = 0;
    for(let i=0;i<n;i++){
      setTimeout(()=> spawnWave(), delay);
      delay += 3800 / state.timeScale;
    }
  }

  function killEnemy(e){
    for(let i=0;i<18;i++) particles.push(new Particle(e.x, e.y, e.color));
    let base = Math.max(6, Math.floor(e.maxHp / 12));
    state.gold += base;
    state.score += (e.score || 10);
    if(Math.random() < 0.16){
      const kinds = ['gold','speed','shield','nuke'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      powerups.push(new PowerUp(e.x + rand(-14,14), e.y + rand(-14,14), kind));
    }
    const idx = enemies.indexOf(e);
    if(idx >= 0) enemies.splice(idx,1);
  }

  function collectAllPowerups(){
    for(let i = powerups.length - 1; i >= 0; i--){
      applyPowerup(powerups[i].kind);
      powerups.splice(i,1);
    }
    flash('Collected all power-ups');
  }

  function applyPowerup(kind){
    flash('Picked: ' + kind);
    if(kind === 'gold') state.gold += 140;
    else if(kind === 'speed'){
      for(let t of towers) t.def.fireRate = Math.max(3, Math.floor(t.def.fireRate * 0.6));
      setTimeout(()=> { rebuildTowerRates(); }, 9000);
    } else if(kind === 'shield') state.lives += 5;
    else if(kind === 'nuke'){ for(let i=enemies.length-1;i>=0;i--) killEnemy(enemies[i]); }
  }

  function rebuildTowerRates(){
    for(let t of towers){
      const base = towerDefs[t.baseId];
      if(base) t.def.fireRate = base.fireRate;
    }
  }

  // Input & placement
  let mouse = {x:0,y:0};
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
    mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
  });
  canvas.addEventListener('mousedown', (e) => { if(e.button === 0) onLeft(mouse.x, mouse.y); });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (canvas.width / r.width);
    const my = (e.clientY - r.top) * (canvas.height / r.height);
    for(let t of towers){
      if(Math.hypot(t.x - mx, t.y - my) < 22){
        const ok = t.upgrade();
        if(ok) flash('Upgraded!');
        else flash('Not enough gold');
        break;
      }
    }
    return false;
  });
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (canvas.width / r.width);
    const my = (ev.clientY - r.top) * (canvas.height / r.height);
    for(let i=powerups.length-1;i>=0;i--){
      const p = powerups[i];
      if(Math.hypot(p.x - mx, p.y - my) <= p.radius + 4){
        applyPowerup(p.kind);
        powerups.splice(i,1);
        break;
      }
    }
  });

  function onLeft(x,y){
    const selected = window.__UI ? window.__UI.selectedTowerId : 'basic';
    const def = towerDefs[selected];
    if(!def) return;
    if(state.gold < def.cost){ flash('Not enough gold'); return; }
    // avoid path
    let tooClose = false;
    for(let i=0;i<path.length-1;i++){
      const a = path[i], b = path[i+1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if(segLen === 0) continue;
      const t = ((x - a.x)*(b.x - a.x) + (y - a.y)*(b.y - a.y)) / (segLen * segLen);
      const tt = clamp(t,0,1);
      const projx = a.x + tt*(b.x - a.x), projy = a.y + tt*(b.y - a.y);
      if(Math.hypot(x - projx, y - projy) < 28){ tooClose = true; break; }
    }
    if(tooClose){ flash('Too close to path'); return; }
    state.gold -= def.cost;
    towers.push(new Tower(x,y,def));
  }

  // update / draw loop
  let last = performance.now();
  function update(){
    const now = performance.now();
    let dt = (now - last) / 16.6667;
    dt *= state.timeScale;
    last = now;
    if(!state.playing) return;

    for(let t of towers) t.update(dt);
    for(let i=projectiles.length-1;i>=0;i--) if(!projectiles[i].update(dt)) projectiles.splice(i,1);
    for(let i=enemies.length-1;i>=0;i--){
      const e = enemies[i];
      if(e.dotTimer && e.dotTimer > 0){
        e.dotTimer -= dt / 1;
        e.hp -= (e.dot || 0) * (dt / 10);
        if(e.dotTimer <= 0){ e.dot = 0; e.dotTimer = 0; }
      }
      e.update(dt);
      if(e.reached){
        state.lives--;
        particles.push(new Particle(e.x,e.y,'#ff6b6b'));
        enemies.splice(i,1);
        if(state.lives <= 0) state.playing = false;
      } else if(e.hp <= 0) killEnemy(e);
    }

    for(let i=particles.length-1;i>=0;i--){ particles[i].update(); if(particles[i].life <= 0) particles.splice(i,1); }
    for(let i=powerups.length-1;i>=0;i--){ powerups[i].update(); if(powerups[i].ttl <= 0) powerups.splice(i,1); }

    if(state.waveActive && enemies.length === 0 && projectiles.length === 0){
      state.waveActive = false;
      state.gold += 80 + Math.floor(state.wave * 10);
    }

    document.getElementById('gold').textContent = state.gold;
    document.getElementById('lives').textContent = state.lives;
    document.getElementById('score').textContent = state.score;
  }

  function draw(){
    ctx.clearRect(0,0,W,H);

    // path
    ctx.lineWidth = 40;
    ctx.strokeStyle = '#b88955';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for(let p of path) ctx.lineTo(p.x,p.y);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#673f1f33';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for(let p of path) ctx.lineTo(p.x,p.y);
    ctx.stroke();

    for(let t of towers) t.draw();
    for(let p of projectiles) p.draw();
    enemies.sort((a,b) => a.pathIndex - b.pathIndex);
    for(let e of enemies) e.draw();
    for(let p of particles) p.draw();
    for(let p of powerups) p.draw();

    if(!state.playing){
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0,0,W,H);
      ctx.fillStyle = '#ff6b6b';
      ctx.font = '48px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', W/2, H/2 - 10);
      ctx.fillStyle = '#fff';
      ctx.font = '18px sans-serif';
      ctx.fillText('Press F5 to try again', W/2, H/2 + 24);
    }
  }

  function loop(){ update(); draw(); requestAnimationFrame(loop); }
  loop();

  // helpers & small functions
  function flash(text){ const el = document.getElementById('message'); el.textContent = text; clearTimeout(window.__flashTimeout); window.__flashTimeout = setTimeout(()=>{ el.textContent = 'Press SPACE to start wave • 1-8 select towers • Click to place'; }, 2200); }

  // expose API for UI
  window.__GAME = {
    spawnWave,
    sendMultipleWaves,
    collectAllPowerups,
    toggleFast: ()=> { state.timeScale = state.timeScale === 1 ? 2 : 1; flash('Time x' + state.timeScale); },
    getState: ()=> state,
    towerDefs // expose for UI if needed
  };

  // utilities
  function rand(min,max){ return Math.random()*(max-min)+min; }
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

})();
