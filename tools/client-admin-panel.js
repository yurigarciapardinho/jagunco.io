// Injected into the saved client's scope by build-official-client.mjs.
// A metadata confirms state; D is reserved for creating a player's life.
const adminDefaults = { godlike: 0, god: 0, aura: 0, boss: 0, invisible: 0, size: 1, power: 1, speed: 1, health: 1 };
let adminPowerState = { ...adminDefaults };
let adminRole = null;
let adminActive = false;

function adminCanUse() {
    return adminRole === "admin" && adminActive;
}

function adminUpdateAccess() {
    const allowed = adminCanUse();
    document.getElementById("adminButton").style.display = allowed ? "" : "none";
    if (!allowed) Al.style.display = "none";
}

function adminReceiveState(state) {
    adminRole = state.role || null;
    adminActive = Boolean(state.active);
    adminPowerState = { ...adminDefaults, ...state.powers };
    qe = adminRole;
    X0();
    adminSyncControls();
}

function adminUpdateSelf(data) {
    if (y && y.id === data[0] && y.sid === data[1]) y.setData(data);
}

function adminDisconnect() {
    adminActive = false;
    X0();
}

function adminSyncControls() {
    const holder = document.getElementById("adminHolder");
    for (const button of holder.querySelectorAll("[data-admin-power]")) {
        const on = Boolean(adminPowerState[button.dataset.adminPower]);
        button.textContent = on ? "Ativado" : "Ativar";
        button.classList.toggle("on", on);
    }
    for (const select of holder.querySelectorAll("[data-admin-multiplier]")) {
        const value = String(adminPowerState[select.dataset.adminMultiplier]);
        // The owner's console also allows values outside the panel's presets.
        if (!Array.from(select.options).some(option => option.value === value)) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value + "×";
            option.disabled = true;
            select.appendChild(option);
        }
        select.value = value;
    }
}

function adminSend(...args) {
    if (adminCanUse()) H.send("A", ...args);
}

function adminToggle() {
    if (!adminCanUse()) {
        Al.style.display = "none";
        return;
    }
    if (Al.style.display === "block") {
        Al.style.display = "none";
        return;
    }
    nt.style.display = "none";
    sn();
    qt();
    Vs.style.display = "none";
    ua();
    Al.style.display = "block";
    adminRender();
}

function adminElement(tag, className, text, parent) {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    parent.appendChild(element);
    return element;
}

function adminRender() {
    const holder = document.getElementById("adminHolder");
    u.removeAllChildren(holder);
    const head = adminElement("div", "adminHead", null, holder);
    adminElement("span", "", "Admin", head);
    const close = adminElement("span", "adminClose", "×", head);
    close.onclick = u.checkTrusted(function () { Al.style.display = "none"; });

    adminElement("div", "adminTitle", "Poderes", holder);
    for (const [key, label] of [["godlike", "Godlike"], ["god", "Imortal"], ["aura", "Aura"], ["boss", "Chefe"], ["invisible", "Invisível"]]) {
        const row = adminElement("div", "adminRow", null, holder);
        adminElement("span", "adminLabel", label, row);
        const button = adminElement("span", "adminBtn", "", row);
        button.dataset.adminPower = key;
        button.onclick = u.checkTrusted(function () {
            adminSend(key, adminPowerState[key] ? 0 : 1);
        });
    }

    adminElement("div", "adminTitle", "Multiplicadores", holder);
    for (const [key, values, label] of [
        ["size", [1, 1.5, 2, 3], "Tamanho"],
        ["power", [1, 2, 5, 10, 20, 50, 100], "Poder"],
        ["speed", [1, 1.5, 2, 5, 10, 20], "Velocidade"],
        ["health", [1, 2, 5, 10, 20], "Vida"]
    ]) {
        const row = adminElement("div", "adminRow", null, holder);
        adminElement("span", "adminLabel", label, row);
        const select = adminElement("select", "adminSelect", null, row);
        select.dataset.adminMultiplier = key;
        for (const value of values) {
            const option = adminElement("option", "", value + "×", select);
            option.value = String(value);
        }
        select.onchange = u.checkTrusted(function () {
            const requested = Number(select.value);
            select.value = String(adminPowerState[key]);
            adminSend(key, requested);
        });
    }

    adminElement("div", "adminTitle", "Recursos", holder);
    const resources = adminElement("div", "adminResources", null, holder);
    resources.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:8px 0";
    ["Madeira", "Comida", "Pedra", "Ouro"].forEach(function (label, index) {
        const button = adminElement("span", "adminBtn", "+10 mil " + label, resources);
        button.style.cssText = "display:block;white-space:normal;margin:0;text-align:center;padding:8px 4px";
        button.onclick = u.checkTrusted(function () { adminSend("give", index, 10000); });
    });

    adminElement("div", "adminTitle", "Animais", holder);
    const row = adminElement("div", "adminRow", null, holder);
    const select = adminElement("select", "adminSelect", null, row);
    bt.kinds.forEach(function (animal, index) {
        if (animal && animal.name) {
            const option = adminElement("option", "", animal.name, select);
            option.value = String(index);
        }
    });
    const summon = adminElement("span", "adminBtn", "Invocar", row);
    summon.onclick = u.checkTrusted(function () { adminSend("spawn", Number(select.value)); });
    adminSyncControls();
}
// END JAGUNCO_ADMIN_PANEL
