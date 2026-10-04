import InfiniteCanvas from '@/components/InfiniteCanvas';
import LoginGate from '@/components/LoginGate';

export default function Home() {
  return (
    <LoginGate>
      <InfiniteCanvas />
    </LoginGate>
  );
}
