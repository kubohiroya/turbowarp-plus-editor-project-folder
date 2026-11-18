type Session = {id: string};

export async function connectExternalFileEditor(browser: Window, filename: string, extension: string, limit: number) {
    // The existing companion serves its authenticated API on the same loopback origin as the Editor.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(browser.location.hostname) || browser.location.protocol !== 'http:') return null;
    const prefix = '/__twpe_yaml';
    let config;
    try {
        const response = await browser.fetch(`${prefix}/config`, {credentials: 'same-origin', cache: 'no-store'});
        if (!response.ok) return null;
        config = await response.json();
    } catch {return null;}
    if (config?.available !== true || typeof config.token !== 'string' || config.editor !== 'VSCode') return null;
    const format = extension === 'json' ? 'json' : ['yaml', 'yml'].includes(extension) ? 'yaml' : 'text';
    if (!(Array.isArray(config.formats) ? config.formats : ['yaml', 'json']).includes(format)) return null;
    const maxBytes = Math.min(limit, Number.isFinite(config.maxSourceBytes) && config.maxSourceBytes > 0 ? config.maxSourceBytes : limit);
    let session: Session | undefined;
    let closed = false;
    const request = async (path: string, method = 'GET', body?: unknown) => {
        const response = await browser.fetch(`${prefix}${path}`, {
            method, credentials: 'same-origin', cache: 'no-store',
            headers: {'X-TWPE-Yaml-Token': config.token, ...(body ? {'Content-Type': 'application/json'} : {})},
            ...(body ? {body: JSON.stringify(body)} : {})
        });
        if (!response.ok) throw new Error('External editor request failed.');
        return response.json();
    };
    const checkSource = (source: unknown): string => {
        if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > maxBytes ||
            /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(source)) throw new Error('Invalid external text.');
        return source;
    };
    const endSession = (id: string) => {void request(`/sessions/${id}`, 'DELETE').catch(() => {});};
    const end = () => {
        if (session) endSession(session.id);
        session = undefined;
    };
    return {
        get active() {return Boolean(session);},
        async open(source: string) {
            if (closed) return;
            if (session) {
                await request(`/sessions/${session.id}`, 'POST');
                return;
            }
            const created = await request('/sessions', 'POST', {source: checkSource(source), sourceName: filename, format});
            if (!/^[a-f0-9]{32}$/u.test(created?.id)) throw new Error('Invalid external editor session.');
            if (closed) {endSession(created.id); return;}
            session = {id: created.id};
        },
        async read() {
            if (closed || !session) throw new Error('No external editor session.');
            const saved = await request(`/sessions/${session.id}`);
            return checkSource(saved.source);
        },
        end,
        close() {closed = true; end();}
    };
}
