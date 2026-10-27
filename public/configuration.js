const configuration = document.getElementById('configuration');
const configurationToggle = document.getElementById('configurationToggle');
const subnetForm = document.getElementById('subnetForm');
const configStatus = document.getElementById('configStatus');
const addSubnet = document.getElementById('addSubnet');
const saveSubnet = document.getElementById('saveSubnet');
let configuredSubnets = [];
let editingSubnet = -1;

async function configRequest(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Impossible de charger la configuration.');
    }
    return response.json();
}

async function loadSubnets() {
    addSubnet.disabled = true;
    const list = document.getElementById('subnetList');
    list.replaceChildren();
    configuredSubnets = await configRequest('/api/subnets');
    configuredSubnets.forEach((subnet, index) => {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = subnet.name + ' — ' + subnet.range + ' ';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Modifier';
        edit.setAttribute('aria-label', 'Modifier ' + subnet.name);
        edit.addEventListener('click', () => openSubnetForm(index));
        item.append(label, edit);
        list.appendChild(item);
    });
    if (!configuredSubnets.length) list.textContent = 'Aucun sous-réseau configuré.';
    addSubnet.disabled = false;
}

function openSubnetForm(index = -1) {
    editingSubnet = index;
    const subnet = configuredSubnets[index] || { name: '', range: '', default: 'share', authorized: [] };
    document.getElementById('subnetFormTitle').textContent = index < 0 ? 'Ajouter un sous-réseau' : 'Modifier un sous-réseau';
    document.getElementById('subnetName').value = subnet.name;
    document.getElementById('subnetRange').value = subnet.range;
    document.getElementById('subnetDefault').value = subnet.default || 'share';
    document.getElementById('subnetAuthorized').value = (subnet.authorized || []).join('\n');
    configStatus.textContent = '';
    subnetForm.hidden = false;
    document.getElementById('subnetName').focus();
}

configurationToggle.addEventListener('click', async () => {
    configuration.hidden = !configuration.hidden;
    configurationToggle.setAttribute('aria-expanded', String(!configuration.hidden));
    if (!configuration.hidden) {
        subnetForm.hidden = true;
        configStatus.textContent = 'Chargement…';
        try {
            await loadSubnets();
            configStatus.textContent = '';
        } catch (error) { configStatus.textContent = error.message; }
    }
});
addSubnet.addEventListener('click', () => openSubnetForm());
document.getElementById('cancelSubnet').addEventListener('click', () => { subnetForm.hidden = true; });
subnetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveSubnet.disabled = true;
    const index = editingSubnet;
    const body = {
        name: document.getElementById('subnetName').value.trim(),
        range: document.getElementById('subnetRange').value.trim(),
        default: document.getElementById('subnetDefault').value,
        authorized: document.getElementById('subnetAuthorized').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    };
    try {
        await configRequest('/api/subnets' + (index < 0 ? '' : '/' + index), {
            method: index < 0 ? 'POST' : 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        subnetForm.hidden = true;
        configStatus.textContent = 'Sous-réseau enregistré. Les règles sont appliquées.';
        await fetchSources();
        try { await loadSubnets(); }
        catch { configStatus.textContent += ' Fermez puis rouvrez Configuration pour actualiser la liste.'; }
    } catch (error) { configStatus.textContent = error.message; }
    finally { saveSubnet.disabled = false; }
});
