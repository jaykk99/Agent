export default function Home() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                   justifyContent: 'center', minHeight: '100vh', padding: '2rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '3rem', fontWeight: 700, marginBottom: '1rem' }}>Agent</h1>
      <p style={{ fontSize: '1.25rem', color: '#888', maxWidth: '480px' }}>
        AI-powered agent platform. Mobile app available on Android.
      </p>
    </main>
  );
}
