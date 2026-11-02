import { useEffect, useState, useRef, type FormEvent } from "react";
import {
  Apple, Axe, Check, Coins, Crosshair, Heart, LockKeyhole, Mountain, Pause, Play,
  Skull, Sparkles, Store, Swords, TreePine, Volume2, VolumeX, Wind, X,
} from "lucide-react";
import { BUILDINGS, SHOP_ITEMS, UPGRADES, WEAPONS, upgradeChoices, type UpgradeId } from "@contracts/game";
import { startGame, stopGame, type GameController } from "@/game/boot";
import { initialHud, type HudState } from "@/game/hud";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [controller, setController] = useState<GameController | null>(null);
  const [hud, setHud] = useState<HudState>(initialHud);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = startGame(canvas, setHud);
    setController(game);
    return () => {
      stopGame();
      setController(null);
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    controller?.join();
  };

  const inRoom = hud.phase === "playing" || hud.phase === "dead";
  const weaponArt = ["weapon_machete", "weapon_spear", "weapon_slingshot"];
  const buildArt = ["", "wall", "spike", "mill_tower"];
  const upgradeIcons = {
    spear: Swords, slingshot: Crosshair, damage: Axe,
    speed: Wind, gather: TreePine, vitality: Heart,
  } satisfies Record<UpgradeId, typeof Axe>;

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} aria-label="Mundo de Jagunco.io" />
      <div id="ui-overlay">
        {hud.phase === "title" && (
          <main className="title-screen">
            <div className="title-vignette" />
            <section className="title-card">
              <div className="title-eyebrow"><span /> UM SURVIVAL .IO NO CORAÇÃO DO SERTÃO <span /></div>
              <h1>JAGUNCO<span>.IO</span></h1>
              <p className="title-subtitle">Colete. Construa. Encare o sertão.</p>
              <p className="title-lore">Entre em uma sala viva, forme sua defesa e dispute o topo do ranking entre jagunços, animais e recursos escassos.</p>
              <form onSubmit={submit} className="join-form">
                <label htmlFor="player-name">SEU NOME NO SERTÃO</label>
                <input
                  id="player-name"
                  value={hud.name}
                  onChange={(event) => controller?.setName(event.target.value)}
                  maxLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Nome do jogador"
                />
                <button className="primary-button" type="submit">
                  <Swords size={20} /> ENTRAR NA SALA PÚBLICA
                </button>
              </form>
              <div className="room-meta"><span className="online-dot" /> MULTIPLAYER REAL <b>•</b> 40 JOGADORES <b>•</b> SEM CADASTRO</div>
              <div className="quick-controls">
                <span><kbd>WASD</kbd> MOVER</span>
                <span><kbd>MOUSE</kbd> MIRAR</span>
                <span><kbd>ESPAÇO</kbd> ATACAR</span>
                <span><kbd>Q</kbd> CURAR</span>
              </div>
            </section>
            <footer className="title-footer">BASE VISUAL JAGUNCO <span>•</span> ELEMENTOS CC0 <span>•</span> SERVIDOR AUTORITATIVO</footer>
          </main>
        )}

        {hud.phase === "connecting" && (
          <div className="modal-screen">
            <div className="loading-emblem"><Swords /></div>
            <h2>ENTRANDO NO SERTÃO</h2>
            <p>Procurando seu lugar na sala pública…</p>
            <div className="loading-bar"><span /></div>
          </div>
        )}

        {inRoom && (
          <>
            <section className="status-panel hud-panel">
              <div className="player-line"><strong>{hud.name}</strong><span>NÍVEL {hud.level}</span></div>
              <div className="health-row">
                <Heart size={17} fill="currentColor" />
                <div className="meter health-meter"><span style={{ width: `${Math.max(0, hud.hp / hud.maxHp * 100)}%` }} /></div>
                <b>{Math.ceil(hud.hp)}</b>
              </div>
              <div className="xp-row"><div className="meter"><span style={{ width: `${hud.xp / hud.nextXp * 100}%` }} /></div><small>{hud.xp}/{hud.nextXp} XP</small></div>
              <div className="resource-grid">
                <div><TreePine /><span>MADEIRA</span><b>{hud.wood}</b></div>
                <div><Apple /><span>COMIDA</span><b>{hud.food}</b></div>
                <div><Mountain /><span>PEDRA</span><b>{hud.stone}</b></div>
                <div><Coins /><span>OURO</span><b>{hud.gold}</b></div>
              </div>
            </section>

            <section className="leaderboard hud-panel">
              <header><Swords size={15} /> OS MAIS TEMIDOS <small>SALA PÚBLICA</small></header>
              {hud.leaders.length === 0 && <p className="empty-board">O ranking está sendo formado…</p>}
              {hud.leaders.map((leader, index) => (
                <div className="leader-row" key={leader.id}>
                  <span className={`rank rank-${index + 1}`}>{index + 1}</span>
                  <strong>{leader.name}</strong>
                  <small>{leader.kills} abates</small>
                  <b>{leader.score.toLocaleString("pt-BR")}</b>
                </div>
              ))}
            </section>

            <div className="top-actions">
              <span className="ping-indicator"><i className={hud.ping < 140 ? "good" : "warn"} /> {hud.ping || "—"} ms</span>
              <button data-testid="shop-button" className={`icon-button ${hud.shopOpen ? "active" : ""}`} disabled={hud.phase !== "playing"} onClick={() => controller?.toggleShop()} aria-label="Abrir loja (B)" title="Loja de equipamentos (B)"><Store /></button>
              <button className="icon-button" onClick={() => controller?.togglePause()} aria-label="Pausar"><Pause /></button>
              <button className="icon-button" onClick={() => controller?.toggleMute()} aria-label={hud.muted ? "Ativar som" : "Silenciar"}>
                {hud.muted ? <VolumeX /> : <Volume2 />}
              </button>
            </div>

            {hud.notice && <div className="notice"><Sparkles size={16} /> {hud.notice}</div>}

            {hud.upgradePoints > 0 && hud.phase === "playing" && (
              <section className="upgrades hud-panel" data-testid="upgrade-panel">
                <header><Sparkles size={15} /> ESCOLHA DE NÍVEL {hud.level} <b>{hud.upgradePoints}</b></header>
                <p>Uma escolha. Sua ramificação.</p>
                {upgradeChoices(hud.level).map((id) => {
                  const Icon = upgradeIcons[id];
                  const chosen = (id === "spear" || id === "slingshot" || id === "vitality") && hud.upgrades.includes(id);
                  return (
                    <button key={id} data-testid={`upgrade-${id}`} disabled={chosen} onClick={() => controller?.upgrade(id)}>
                      <Icon /><span>{UPGRADES[id].name}<small>{UPGRADES[id].description}</small></span><b>+</b>
                    </button>
                  );
                })}
              </section>
            )}

            {hud.shopOpen && hud.phase === "playing" && (
              <section className="shop-panel hud-panel" data-testid="shop-panel" aria-label="Loja do sertão">
                <header><Store size={18} /><span>LOJA DO SERTÃO<small>Equipamentos comprados ficam após o respawn</small></span><button onClick={() => controller?.toggleShop()} aria-label="Fechar loja"><X /></button></header>
                <div className="shop-balance"><span>SALDO DISPONÍVEL</span><b><Coins /> {hud.gold}</b></div>
                <div className="shop-grid">
                  {SHOP_ITEMS.map((item) => {
                    const owned = hud.ownedItems.includes(item.id);
                    const equipped = item.slot === "hat" ? hud.equippedHat === item.id : hud.equippedAccessory === item.id;
                    return (
                      <button
                        key={item.id}
                        data-testid={`shop-item-${item.id}`}
                        className={`shop-item ${equipped ? "equipped" : ""} ${!owned && hud.gold < item.price ? "unaffordable" : ""}`}
                        onClick={() => owned ? controller?.equipItem(item.id) : controller?.buyItem(item.id)}
                      >
                        <span className="shop-item-icon">{item.slot === "hat" ? <Store /> : item.id === "boots" ? <Wind /> : item.id === "patua" ? <Heart /> : <Swords />}</span>
                        <span className="shop-item-copy"><small>{item.slot === "hat" ? "CHAPÉU" : "ACESSÓRIO"}</small><strong>{item.name}</strong><span>{item.description}</span></span>
                        <b className="shop-item-action">{equipped ? <><Check /> EQUIPADO</> : owned ? "EQUIPAR" : <><Coins /> {item.price}</>}</b>
                      </button>
                    );
                  })}
                </div>
                <footer><kbd>B</kbd> FECHAR • COMPRAR EQUIPA AUTOMATICAMENTE</footer>
              </section>
            )}

            <section className="hotbar" aria-label="Armas e construções">
              {WEAPONS.map((weapon, index) => (
                <button
                  key={weapon.name}
                  className={`hotbar-slot ${hud.weapon === index ? "selected" : ""}`}
                  disabled={!hud.unlockedWeapons.includes(index)}
                  onClick={() => controller?.selectWeapon(index)}
                  title={!hud.unlockedWeapons.includes(index) ? `Escolha esta arma no nível ${weapon.unlock}` : weapon.name}
                >
                  <kbd>{index + 1}</kbd>
                  <img className="item-icon weapon-icon" src={`/art/icons/${weaponArt[index]}.png`} alt="" draggable={false} />
                  <span>{index === 0 ? "FACÃO" : index === 1 ? "LANÇA" : "ESTILINGUE"}</span>
                  {!hud.unlockedWeapons.includes(index) && <small><LockKeyhole /> NÍV. {weapon.unlock}</small>}
                </button>
              ))}
              <div className="hotbar-divider" />
              {BUILDINGS.slice(1).map((building, offset) => {
                const index = offset + 1;
                return (
                  <button
                    key={building!.kind}
                    className={`hotbar-slot build-slot ${hud.build === index ? "selected" : ""}`}
                    onClick={() => controller?.selectBuild(index)}
                    title={`${building!.name}: ${building!.cost.wood} madeira + ${building!.cost.stone} pedra`}
                  >
                    <kbd>{["Z", "X", "C"][offset]}</kbd>
                    <img className="item-icon" src={`/art/icons/${buildArt[index]}.png`} alt="" draggable={false} />
                    <span>{["CERCA", "ARAME", "MOINHO"][offset]}</span>
                    <small><TreePine />{building!.cost.wood} <Mountain />{building!.cost.stone}</small>
                  </button>
                );
              })}
              <button className="hotbar-slot heal-slot" onClick={() => controller?.heal()} title="Consumir 10 comidas para recuperar 35 de vida">
                <kbd>Q</kbd><Apple /><span>CURAR</span><small>10 <Apple /></small>
              </button>
            </section>

            <div className="desktop-hint"><span><kbd>Z X C</kbd> CONSTRUIR</span><span><kbd>B</kbd> LOJA</span><span><kbd>1 2 3</kbd> ARMAS</span><span><kbd>ESC</kbd> PAUSA</span></div>
            <div className="mobile-actions">
              <button
                className="attack-button"
                onPointerDown={() => controller?.setAttack(true)}
                onPointerUp={() => controller?.setAttack(false)}
                onPointerCancel={() => controller?.setAttack(false)}
              ><Swords /> ATACAR</button>
              <button onClick={() => controller?.heal()}><Apple /> CURAR</button>
            </div>
          </>
        )}

        {hud.phase === "dead" && (
          <div className="modal-screen death-screen">
            <div className="death-card">
              <Skull className="death-icon" />
              <span className="modal-eyebrow">FIM DA JORNADA</span>
              <h2>VOCÊ CAIU NO SERTÃO</h2>
              <p>{hud.deathBy || "A disputa pelo território não perdoa."}</p>
              <div className="death-stats"><span>PONTUAÇÃO <b>{hud.score}</b></span><span>ABATES <b>{hud.kills}</b></span><span>NÍVEL <b>{hud.level}</b></span></div>
              <button className="primary-button" onClick={() => controller?.respawn()}><Play /> VOLTAR AO SERTÃO</button>
              <small>ou pressione ESPAÇO</small>
            </div>
          </div>
        )}

        {hud.paused && hud.phase === "playing" && (
          <div className="modal-screen pause-screen">
            <div className="pause-card">
              <span className="modal-eyebrow">RESPIRO RÁPIDO</span>
              <h2>JOGO PAUSADO</h2>
              <p>A sala continua viva enquanto você descansa.</p>
              <button className="primary-button" onClick={() => controller?.togglePause()}><Play /> CONTINUAR</button>
            </div>
          </div>
        )}

        {hud.phase === "error" && (
          <div className="modal-screen">
            <div className="pause-card">
              <span className="modal-eyebrow">CONEXÃO INTERROMPIDA</span>
              <h2>O SERTÃO FICOU DISTANTE</h2>
              <p>{hud.notice || "Não foi possível conectar à sala."}</p>
              <button className="primary-button" onClick={() => controller?.join()}><Play /> TENTAR NOVAMENTE</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
