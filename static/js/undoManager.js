/**
 * Generic Undo/Redo Manager
 * Stores deep-cloned snapshots of state.
 */
class UndoManager {
    constructor(maxHistory = 50) {
        this.history = [];
        this.redoStack = [];
        this.maxHistory = maxHistory;
    }

    snapshot(state) {
        this.history.push(JSON.parse(JSON.stringify(state)));
        this.redoStack = [];
        if (this.history.length > this.maxHistory) this.history.shift();
    }

    undo(currentState) {
        if (this.history.length === 0) return null;
        this.redoStack.push(JSON.parse(JSON.stringify(currentState)));
        return this.history.pop();
    }

    redo(currentState) {
        if (this.redoStack.length === 0) return null;
        this.history.push(JSON.parse(JSON.stringify(currentState)));
        return this.redoStack.pop();
    }

    canUndo() { return this.history.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    clear() {
        this.history = [];
        this.redoStack = [];
    }
}
