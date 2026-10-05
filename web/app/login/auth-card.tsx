// The card every signed-out page stands on: sign in, forgot password, new password.
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
          <span>Easy<span className="bo-brand-pos">Pay</span></span>
        </div>
        {children}
      </div>
    </main>
  );
}
