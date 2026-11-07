import {equal, isObject, unsupported} from './source.js';
import type {Json, Project} from './source.js';

type Value = string | number | boolean;
type Point = {x: number; y: number};
type Field = {value: Value; id?: string | null};
type Block = {
    id: string; opcode: string; topLevel: boolean; shadow: boolean; isMonitored?: boolean;
    parent?: string; x?: number; y?: number;
    fields: Record<string, Field>;
    inputs: Record<string, {block: string | null; shadow: string | null}>;
};
export type ReloadTarget = {
    isStage: boolean; isOriginal: boolean; getName(): string;
    blocks: {
        getBlock(id: string): Block | undefined;
        changeBlock(event: {id: string; element: 'field'; name: string; value: Value}): void;
        moveBlock(event: {id: string; newCoordinate: Point}): void;
    };
};

type ScalarChange = {kind: 'field'; name: string; before: Value; after: Value} |
    {kind: 'input'; name: string; connected: string | null; tag: number; before: Value; after: Value};
type Change = ScalarChange | {kind: 'position'; before: Point; after: Point};
type BlockChange = Change & {id: string; target: string; stage: boolean; opcode: string};

const isValue = (value: Json): value is Value =>
    typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const literals: Record<number, [string, string]> = {
    4: ['math_number', 'NUM'], 5: ['math_positive_number', 'NUM'], 6: ['math_whole_number', 'NUM'],
    7: ['math_integer', 'NUM'], 8: ['math_angle', 'NUM'], 9: ['colour_picker', 'COLOUR'], 10: ['text', 'TEXT']
};
const reject = (): never => unsupported('Only values and coordinates of existing blocks can be reloaded');
const keysMatch = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    equal(Object.keys(before), Object.keys(after));
const point = (x: Json, y: Json): Point => {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return reject();
    return {x, y};
};

export function planBlockReload(before: Project, after: Project): BlockChange[] {
    const {targets: oldTargets, ...oldProject} = before;
    const {targets: newTargets, ...newProject} = after;
    if (oldTargets.length !== newTargets.length || !equal(oldProject, newProject)) return reject();
    const edits: BlockChange[] = [];
    for (const [index, oldTarget] of oldTargets.entries()) {
        const {blocks: oldBlocks, ...oldRest} = oldTarget;
        const {blocks: newBlocks, ...newRest} = newTargets[index];
        if (!equal(oldRest, newRest)) return reject();
        if (!isObject(oldBlocks) || !isObject(newBlocks)) {
            if (equal(oldBlocks, newBlocks)) continue;
            return reject();
        }
        if (!keysMatch(oldBlocks, newBlocks)) return reject();
        for (const [id, oldBlock] of Object.entries(oldBlocks)) {
            const newBlock = newBlocks[id];
            if (equal(oldBlock, newBlock)) continue;
            if (!isObject(oldBlock) || !isObject(newBlock)) return reject();
            const {inputs: oldInputs, fields: oldFields, x: oldX, y: oldY, ...oldShape} = oldBlock;
            const {inputs: newInputs, fields: newFields, x: newX, y: newY, ...newShape} = newBlock;
            if (!equal(oldShape, newShape) || typeof oldShape.opcode !== 'string') return reject();
            const common = {id, target: oldTarget.name, stage: oldTarget.isStage, opcode: oldShape.opcode};
            if (oldX !== newX || oldY !== newY) {
                if (oldShape.topLevel !== true) return reject();
                edits.push({...common, kind: 'position', before: point(oldX, oldY), after: point(newX, newY)});
            }
            if (!equal(oldFields, newFields)) {
                if (!isObject(oldFields) || !isObject(newFields) || !keysMatch(oldFields, newFields)) return reject();
                for (const [name, a] of Object.entries(oldFields)) {
                    const b = newFields[name];
                    if (equal(a, b)) continue;
                    if (['VARIABLE', 'LIST', 'BROADCAST_OPTION'].includes(name) || oldShape.opcode === 'sensing_of_object_menu' ||
                        !Array.isArray(a) || !Array.isArray(b) || a.length !== 1 || b.length !== 1 ||
                        !isValue(a[0]) || !isValue(b[0])) return reject();
                    edits.push({...common, kind: 'field', name, before: a[0], after: b[0]});
                }
            }
            if (!equal(oldInputs, newInputs)) {
                if (!isObject(oldInputs) || !isObject(newInputs) || !keysMatch(oldInputs, newInputs)) return reject();
                for (const [name, a] of Object.entries(oldInputs)) {
                    const b = newInputs[name];
                    if (equal(a, b)) continue;
                    if (!Array.isArray(a) || !Array.isArray(b) || a[0] !== b[0]) return reject();
                    const slot = a[0] === 1 ? 1 : a[0] === 3 && typeof a[1] === 'string' && a[1] === b[1] ? 2 : null;
                    if (slot === null || a.length !== slot + 1 || b.length !== slot + 1) return reject();
                    const from = a[slot];
                    const to = b[slot];
                    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 2 || to.length !== 2 ||
                        typeof from[0] !== 'number' || !Object.hasOwn(literals, from[0]) || from[0] !== to[0] ||
                        !isValue(from[1]) || !isValue(to[1])) return reject();
                    const connected = slot === 2 ? a[1] as string : null;
                    edits.push({...common, kind: 'input', name, connected, tag: from[0], before: from[1], after: to[1]});
                }
            }
        }
    }
    return edits;
}

export function applyBlockReload(targets: readonly ReloadTarget[], edits: BlockChange[]) {
    const touched = new Set<ReloadTarget>();
    // Resolve all edits before invoking any VM mutation.
    const operations = edits.map(edit => {
        const matching = targets.filter(target => target.isStage === edit.stage &&
            (edit.stage || target.isOriginal && target.getName() === edit.target));
        if (matching.length !== 1) return reject();
        const target = matching[0];
        const container = target.blocks;
        const parent = container.getBlock(edit.id);
        if (!parent || parent.opcode !== edit.opcode) return reject();
        touched.add(target);
        if (edit.kind === 'position') {
            if (!parent.topLevel || Math.round(parent.x ?? 0) !== edit.before.x || Math.round(parent.y ?? 0) !== edit.before.y) {
                return reject();
            }
            return (direction: 'before' | 'after') => container.moveBlock({id: edit.id, newCoordinate: edit[direction]});
        }
        let block = parent;
        let name = edit.name;
        if (edit.kind === 'input') {
            const input = parent.inputs[edit.name];
            const shadow = input?.shadow;
            if (!shadow || input.block !== (edit.connected ?? shadow)) return reject();
            const literal = container.getBlock(shadow);
            const [opcode, field] = literals[edit.tag];
            if (!literal?.shadow || literal.parent !== parent.id || literal.opcode !== opcode) return reject();
            block = literal;
            name = field;
        }
        const field = block.fields[name];
        if (!field || field.id != null || field.value !== edit.before || block.isMonitored || parent.isMonitored) return reject();
        return (direction: 'before' | 'after') => container.changeBlock({
            id: block.id, element: 'field', name, value: edit[direction]
        });
    });
    let index = 0;
    try {
        for (; index < operations.length; index++) operations[index]('after');
    } catch (error) {
        // VM events can fail after a mutation. Restore the attempted batch in reverse order.
        for (; index >= 0; index--) operations[index]('before');
        throw error;
    }
    return [...touched];
}
