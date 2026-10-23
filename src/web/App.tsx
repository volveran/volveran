// Root of the Volverán web app. The walking skeleton (#2) brings the queue list.
import { product } from '../shared/product.js';

export function App() {
  return (
    <main>
      <h1>{product.name}</h1>
      <p>Dead letters come back.</p>
    </main>
  );
}
