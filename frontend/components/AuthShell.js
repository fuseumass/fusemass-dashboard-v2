import Logo from "@/components/Logo";

// Centered card layout shared by all auth pages (login, signup, reset, etc.).
export default function AuthShell({ title, subtitle, children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background:
          "radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--brand) 14%, transparent), transparent), var(--background)",
      }}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 420, padding: "2rem" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: "1.25rem",
          }}
        >
          <Logo variant="v1" height={44} />
        </div>
        <h1
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            textAlign: "center",
            marginBottom: subtitle ? "0.25rem" : "1.25rem",
          }}
        >
          {title}
        </h1>
        {subtitle
          ? <p
              className="muted"
              style={{
                textAlign: "center",
                marginBottom: "1.25rem",
                fontSize: "0.9rem",
              }}
            >
              {subtitle}
            </p>
          : null}
        {children}
      </div>
    </div>
  );
}
