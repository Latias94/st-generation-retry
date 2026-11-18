import { createConnection } from 'node:net';

const PIPE = '\\\\.\\pipe\\SillyTavern.GenerationNotifier.v1';
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const OUTCOMES = new Set(['success', 'failure', 'test']);
const FAILURE_CODES = new Set(['request-rejected', 'upstream-error', 'network-error', 'empty-response', 'incomplete-stream',
    'invalid-stream', 'invalid-response', 'expected-stream', 'tool-error']);
const EVENT_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export const info = {
    id: 'st-generation-notifier',
    name: 'Generation Notifier',
    description: 'Relays local generation outcomes to the Windows tray application.',
};

function readEvent(body) {
    if (!body || typeof body.id !== 'string' || !EVENT_ID.test(body.id) || !OUTCOMES.has(body.outcome)) return null;
    const { id, outcome, retries, code, status, partial } = body;
    if (!Number.isInteger(retries) || retries < 0 || retries > 2147483647) return null;
    const event = { id, outcome, retries };
    if (outcome === 'failure') {
        if (FAILURE_CODES.has(code)) event.code = code;
        if (Number.isInteger(status) && status >= 400 && status <= 599) event.status = status;
        event.partial = partial === true;
    }
    return event;
}

function sendToPipe(event) {
    return new Promise(resolve => {
        const socket = createConnection(PIPE);
        const finish = status => {
            resolve(status);
            socket.destroy();
        };
        socket.setTimeout(2500, () => finish(503));
        socket.once('error', () => finish(503));
        socket.once('close', () => resolve(503));
        socket.once('connect', () => socket.write(`${JSON.stringify(event)}\n`));
        socket.once('data', receipt => {
            switch (receipt.toString('ascii')) {
                case 'S': finish(204); break;
                case 'P': finish(202); break;
                case 'D': finish(409); break;
                default: finish(502); break;
            }
        });
    });
}

export async function init(router) {
    router.post('/notify', async (request, response) => {
        if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress) || !LOOPBACK_HOSTS.has(request.hostname?.toLowerCase())) {
            return response.status(403).end();
        }
        const event = readEvent(request.body);
        if (!event) return response.status(400).end();
        const status = process.platform === 'win32' ? await sendToPipe(event) : 503;
        return response.status(status).end();
    });
}
