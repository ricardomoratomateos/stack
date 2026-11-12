import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { declarationsOf, importResolver, LightIndex, projectDirOf, sourceFiles, type Grep } from '../../src/code/lightIndex';

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { 'app/*': ['./src/*'], '@lib': ['./lib/index.ts'] } } }),
  'src/money.ts': 'export type Amount = number;\nexport function add(a: Amount, b: Amount): Amount { return a + b; }\nconst hidden = 1;\n',
  'src/steps.ts': 'const Steps = {\n  START: \'start\',\n  END: \'end\',\n} as const;\ntype Steps = (typeof Steps)[keyof typeof Steps];\nexport { Steps };\n',
  'src/Dot.tsx': 'const Dot = () => null;\nexport default Dot;\n',
  'src/shape.ts': 'export enum Shape { Round, Square }\nexport class Box {\n  size = 1;\n  grow(): void {}\n}\nexport interface Named { name: string }\n',
  'src/index.ts': 'export * from \'./money\';\nexport { Shape as Form } from \'./shape\';\n',
  'lib/index.ts': 'export const libValue = 1;\n',
  'src/use.tsx': [
    'import { add, Amount } from \'app/money\';',            // 0
    'import Dot from \'./Dot\';',                             // 1
    'import { Steps } from \'app/steps\';',                   // 2
    'import { Form } from \'app\';',                          // 3
    'import { libValue } from \'@lib\';',                     // 4
    'import { useThing } from \'some-library\';',             // 5
    'import * as money from \'./money\';',                    // 6
    'const helper = (n: Amount) => add(n, 1);',               // 7
    'export const View = ({ total }: { total: Amount }) => {',// 8
    '  const { value } = useThing();',                        // 9
    '  const step = Steps.END;',                              // 10
    '  const shape = Form.Round;',                            // 11
    '  money.add(libValue, value.deep);',                     // 12
    '  return <Dot>{helper(total)}</Dot>;',                   // 13
    '};',
  ].join('\n'),
  'src/other.ts': 'import { add } from \'./index\';\nexport const two = add(1, 1);\n',
  'node_modules/some-library/index.js': 'export const add = 1;\n',
};

describe('light JS/TS index', () => {
  let dir: string;
  let index: LightIndex;
  const grep: Grep = async (_project, name) => {
    const out: Array<[string, number, string]> = [];
    for (const [rel, text] of Object.entries(FILES)) {
      if (!/\.tsx?$/.test(rel) || rel.startsWith('node_modules')) continue;
      text.split('\n').forEach((line, i) => { if (new RegExp(`\\b${name}\\b`).test(line)) out.push([rel, i, line]); });
    }
    return out;
  };
  const use = (): string => path.join(dir, 'src/use.tsx');
  const def = (line: number, col: number): string[] =>
    index.definition(use(), FILES['src/use.tsx'], line, col).map((p) => `${path.relative(dir, p.file)}:${p.line}:${p.col}`);

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-light-')));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const progress: Array<[number, number]> = [];
    index = await LightIndex.build(dir, (done, total) => progress.push([done, total]), grep);
    expect(progress.at(-1)).toEqual([8, 8]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('indexes our sources and leaves node_modules alone', () => {
    expect(sourceFiles(dir).map((f) => path.relative(dir, f)).sort()).toEqual(
      ['lib/index.ts', 'src/Dot.tsx', 'src/index.ts', 'src/money.ts', 'src/other.ts', 'src/shape.ts', 'src/steps.ts', 'src/use.tsx'],
    );
    expect(index.files).toBe(8);
  });

  it('records what a file declares, exports and re-exports', () => {
    const shape = declarationsOf('shape.ts', FILES['src/shape.ts']);
    expect(shape.d.map((d) => `${d[3]} ${d[4] ? d[4] + '.' : ''}${d[0]}${d[5] ? ' (exported)' : ''}`)).toEqual([
      'enum Shape (exported)', 'property Shape.Round', 'property Shape.Square',
      'class Box (exported)', 'property Box.size', 'method Box.grow', 'interface Named (exported)', 'property Named.name',
    ]);
    expect(declarationsOf('index.ts', FILES['src/index.ts']).r).toEqual([['*', '*', './money'], ['Form', 'Shape', './shape']]);
    expect(declarationsOf('Dot.tsx', FILES['src/Dot.tsx']).r).toEqual([['default', 'Dot', '']]);
  });

  it('resolves our own imports through relative paths and tsconfig paths, never a library', () => {
    const resolve = importResolver(dir);
    expect(resolve(use(), './Dot')).toBe(path.join(dir, 'src/Dot.tsx'));
    expect(resolve(use(), 'app/money')).toBe(path.join(dir, 'src/money.ts'));
    expect(resolve(use(), 'app')).toBeUndefined(); // "app/*" needs something after the slash…
    expect(resolve(use(), '@lib')).toBe(path.join(dir, 'lib/index.ts'));
    expect(resolve(use(), 'some-library')).toBeUndefined();
    expect(projectDirOf(dir, use())).toBe(dir);
  });

  it('goes to the definition of an imported name, a default import, and through re-exports', () => {
    expect(def(7, 31)).toEqual(['src/money.ts:1:16']);  // add( … )  -> the function
    expect(def(7, 19)).toEqual(['src/money.ts:0:12']);  // Amount    -> the type
    expect(def(13, 11)).toEqual(['src/Dot.tsx:0:6']);   // <Dot>     -> export default Dot
    expect(def(4, 10)).toEqual(['lib/index.ts:0:13']);  // libValue  -> through a tsconfig path
    expect(index.definition(path.join(dir, 'src/other.ts'), FILES['src/other.ts'], 1, 19).map((p) => path.relative(dir, p.file))).toEqual(['src/money.ts']); // export *
  });

  it('goes to locals, parameters and destructured names in the same file', () => {
    expect(def(13, 16)).toEqual(['src/use.tsx:7:6']);   // helper(
    expect(def(13, 23)).toEqual(['src/use.tsx:8:23']);  // total, the destructured parameter
    expect(def(12, 22)).toEqual(['src/use.tsx:9:10']);  // value
  });

  it('goes to a member of something it can name: a const object, a namespace import', () => {
    expect(def(10, 21)).toEqual(['src/steps.ts:2:2']);  // Steps.END
    expect(def(12, 9)).toEqual(['src/money.ts:1:16']);  // money.add
  });

  it('says nothing, rather than guess, when the answer needs a type or lives in a library', () => {
    expect(def(12, 30)).toEqual([]); // value.deep: `value` comes from a library hook
    expect(def(9, 21)).toEqual([]);  // useThing: a library import
    expect(def(11, 21)).toEqual([]); // Form.Round: `Form` is a renamed re-export; its members are filed under `Shape`
    expect(def(14, 0)).toEqual([]);  // not on a name
  });

  it('finds references in the files that import the name from that module', async () => {
    const refs = await index.references(use(), FILES['src/use.tsx'], 7, 31); // add
    expect(refs.map((p) => `${path.relative(dir, p.file)}:${p.line}`).sort()).toEqual([
      'src/money.ts:1', 'src/other.ts:0', 'src/other.ts:1', 'src/use.tsx:0', 'src/use.tsx:12', 'src/use.tsx:7',
    ]);
    const member = await index.references(use(), FILES['src/use.tsx'], 10, 21); // Steps.END: whoever imports Steps
    expect(member.map((p) => `${path.relative(dir, p.file)}:${p.line}`).sort()).toEqual(['src/steps.ts:2', 'src/use.tsx:10']);
    expect(await index.references(use(), FILES['src/use.tsx'], 14, 0)).toEqual([]);
  });

  it('lists symbols by name and outlines a file; a changed file is re-read', () => {
    expect(index.symbols('add').map((s) => s.name)).toEqual(['add']);
    expect(index.symbols('')).toEqual([]);
    expect(index.outline(use(), FILES['src/use.tsx']).map((d) => d[0])).toEqual(['helper', 'View']);
    const file = path.join(dir, 'src/money.ts');
    fs.writeFileSync(file, FILES['src/money.ts'] + 'export const added = 2;\n');
    index.refresh(file);
    expect(index.symbols('added').map((s) => s.name)).toEqual(['added']);
    fs.rmSync(file);
    index.refresh(file);
    expect(index.symbols('add')).toEqual([]);
  });
});
