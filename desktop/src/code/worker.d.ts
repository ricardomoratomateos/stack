// Vite's `?worker` import: a constructor for a module worker built from that file.
declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
