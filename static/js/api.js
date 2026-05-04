/**
 * API client helper - fetch wrappers for backend communication
 */
const API = {
    async get(url) {
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }
        return res.json();
    },

    async post(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {}),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }
        return res.json();
    },

    async put(url, data) {
        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {}),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }
        return res.json();
    },

    async del(url) {
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }
        return res.json();
    },

    /** Poll a task until complete or error */
    async pollTask(taskId, onProgress, intervalMs = 2000) {
        while (true) {
            const status = await this.get(`/pnid_anno/api/task/${taskId}/status`);
            if (onProgress) onProgress(status);
            if (status.status === 'complete') return status;
            if (status.status === 'error') throw new Error(status.error || 'Task failed');
            await new Promise(r => setTimeout(r, intervalMs));
        }
    },

    sessionUrl(path) {
        return `/pnid_anno/api/session/${SESSION_ID}${path}`;
    }
};
