import {equal, isObject, unsupported} from './source.js';
import type {Json, JsonObject, Project} from './source.js';
import type {ReloadTarget} from './block-reload.js';

/** A block as the VM stores it after `deserializeBlocks`. */
export type VmBlock = {
    id: string; opcode: string; topLevel: boolean; parent?: string | null; comment?: string;
    fields: Record<string, {name?: string; value: unknown; id?: string | null; variableType?: string}>;
};
/** The VM's sb3 `deserializeBlocks`: turns serialized blocks into VM blocks, in place. Results are checked before use. */
export type DeserializeBlocks = (blocks: Record<string, unknown>) => Record<string, {id: string}>;

type Container = ReloadTarget['blocks'] & {
    _blocks: Record<string, VmBlock>;
    _scripts: string[];
    createBlock(block: VmBlock, deferProjectChanged?: boolean): void;
    deleteBlock(id: string): void;
    resetCache(): void;
};
export type ScriptReloadTarget = ReloadTarget & {
    blocks: Container;
    comments?: Record<string, unknown>;
    lookupVariableById?(id: string): unknown;
};

/** Replace whole scripts of one target: delete the old top blocks, then create the new scripts' blocks. */
export type ScriptEdit = {target: string; stage: boolean; remove: string[]; blocks: JsonObject};

const reject = (detail = 'Only changes to the scripts of existing targets can be reloaded in place'): never =>
    unsupported(detail);
// Shadow and menu blocks use these prefixes too. Other prefixes must already appear in the project,
// so that a reload never needs an extension the VM has not loaded.
const corePrefixes = new Set(['motion', 'looks', 'sound', 'event', 'control', 'sensing', 'operator', 'data',
    'procedures', 'argument', 'math', 'text', 'colour']);
const prefix = (opcode: string) => opcode.split('_', 1)[0];
const variableFields = new Set(['VARIABLE', 'LIST', 'BROADCAST_OPTION']);

// A top-level primitive is stored as an array and is its own script.
const parentOf = (block: Json): string | null => isObject(block) && typeof block.parent === 'string' ? block.parent : null;

function rootsOf(blocks: JsonObject) {
    const roots = new Map<string, string>();
    for (const id of Object.keys(blocks)) {
        let current = id;
        const seen = new Set<string>();
        for (;;) {
            if (seen.has(current)) return reject('Blocks form a cycle');
            seen.add(current);
            const parent = parentOf(blocks[current]);
            if (parent === null) break;
            if (!Object.hasOwn(blocks, parent)) return reject('A block refers to a missing parent');
            current = parent;
        }
        roots.set(id, current);
    }
    return roots;
}

function opcodesOf(blocks: JsonObject, into: Set<string>) {
    for (const block of Object.values(blocks)) {
        if (isObject(block) && typeof block.opcode === 'string') into.add(prefix(block.opcode));
    }
}

/**
 * Plans script replacements for changes that add, remove or reconnect blocks. Every other property of the
 * project and its targets, including comments, must stay the same; otherwise the whole project is reloaded.
 */
export function planScriptReload(before: Project, after: Project): ScriptEdit[] {
    const {targets: oldTargets, ...oldProject} = before;
    const {targets: newTargets, ...newProject} = after;
    if (oldTargets.length !== newTargets.length || !equal(oldProject, newProject)) return reject();
    const known = new Set(corePrefixes);
    for (const target of oldTargets) if (isObject(target.blocks)) opcodesOf(target.blocks, known);
    const edits: ScriptEdit[] = [];
    for (const [index, oldTarget] of oldTargets.entries()) {
        const {blocks: oldValue, ...oldRest} = oldTarget;
        const {blocks: newValue, ...newRest} = newTargets[index];
        if (!equal(oldRest, newRest)) return reject();
        if (equal(oldValue, newValue)) continue;
        const oldBlocks = isObject(oldValue) ? oldValue : {};
        const newBlocks = isObject(newValue) ? newValue : {};
        const oldRoots = rootsOf(oldBlocks);
        const newRoots = rootsOf(newBlocks);
        const removed = new Set<string>();
        const added = new Set<string>();
        const mark = (id: string) => {
            const oldRoot = oldRoots.get(id);
            const newRoot = newRoots.get(id);
            let grew = false;
            if (oldRoot !== undefined && !removed.has(oldRoot)) {removed.add(oldRoot); grew = true;}
            if (newRoot !== undefined && !added.has(newRoot)) {added.add(newRoot); grew = true;}
            return grew;
        };
        for (const id of new Set([...Object.keys(oldBlocks), ...Object.keys(newBlocks)])) {
            if (!equal(oldBlocks[id], newBlocks[id])) mark(id);
        }
        // A block in a replaced script is replaced with it on both sides, so no script is left half-moved.
        for (let grew = true; grew;) {
            grew = false;
            for (const [id, root] of oldRoots) if (removed.has(root) && mark(id)) grew = true;
            for (const [id, root] of newRoots) if (added.has(root) && mark(id)) grew = true;
        }
        const blocks: JsonObject = {};
        for (const [id, root] of newRoots) if (added.has(root)) blocks[id] = newBlocks[id];
        for (const block of Object.values(blocks)) {
            if (!isObject(block)) continue;
            if (typeof block.opcode !== 'string') return reject('A block has no opcode');
            if (!known.has(prefix(block.opcode))) return reject(`Blocks need an extension the project does not use: ${block.opcode}`);
        }
        edits.push({target: oldTarget.name, stage: oldTarget.isStage, remove: [...removed], blocks});
    }
    return edits;
}

const resolveTarget = (targets: readonly ScriptReloadTarget[], edit: ScriptEdit) => {
    const matching = targets.filter(target => target.isStage === edit.stage &&
        (edit.stage || target.isOriginal && target.getName() === edit.target));
    return matching.length === 1 ? matching[0] : reject();
};

/**
 * Applies planned script replacements. Every edit is checked against the VM before any change. If a change
 * fails part way, every target is restored to its previous blocks.
 */
export function applyScriptReload(targets: readonly ScriptReloadTarget[], edits: ScriptEdit[], deserialize: DeserializeBlocks) {
    const prepared = edits.map(edit => {
        const target = resolveTarget(targets, edit);
        const container = target.blocks;
        for (const id of edit.remove) {
            const block = container.getBlock(id);
            if (!block || !block.topLevel || !container._scripts.includes(id)) return reject('The editor and the folder differ');
        }
        const created = Object.values(deserialize(JSON.parse(JSON.stringify(edit.blocks)))) as VmBlock[];
        for (const block of created) {
            if (typeof block.id !== 'string' || typeof block.opcode !== 'string') return reject('A block could not be read');
            if (block.comment && !(target.comments && Object.hasOwn(target.comments, block.comment))) {
                return reject('A block refers to a missing comment');
            }
            for (const [name, field] of Object.entries(block.fields ?? {})) {
                if (!variableFields.has(name) && !field.variableType) continue;
                if (typeof field.id !== 'string' || !target.lookupVariableById?.(field.id)) {
                    return reject('A block refers to a variable, list or message the project does not have');
                }
            }
        }
        return {target, container, edit, created};
    });
    const saved = prepared.map(({container}) => ({container, blocks: {...container._blocks}, scripts: [...container._scripts],
        tops: new Map(Object.entries(container._blocks).map(([id, block]) => [id, block.topLevel]))}));
    try {
        for (const {container, edit, created} of prepared) {
            for (const id of edit.remove) container.deleteBlock(id);
            for (const block of created) {
                container.createBlock(block, true);
                // createBlock ignores an id that is already present, which would leave the script incomplete.
                if (container._blocks[block.id] !== block) reject('A block id is already in use');
            }
            container.resetCache();
        }
    } catch (error) {
        for (const {container, blocks, scripts, tops} of saved) {
            container._blocks = blocks;
            container._scripts = scripts;
            for (const [id, top] of tops) blocks[id].topLevel = top;
            container.resetCache();
        }
        throw error;
    }
    return prepared.map(({target}) => target);
}
