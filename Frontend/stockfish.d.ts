declare module "stockfish.js" {
  function Stockfish(): {
    postMessage(command: string): void;
    onmessage: (event: string | MessageEvent) => void;
    terminate(): void;
  };
  export default Stockfish;
}