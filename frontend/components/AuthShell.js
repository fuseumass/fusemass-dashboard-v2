import Logo from "@/components/Logo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// The one layout every signed-out page uses (login, signup, password reset,
// the Google callback): a single card on a plain page. `footer` is for the
// "no account? Sign up" line under the card body.
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Logo variant="v1" height={40} />
        </div>
        <Card className="gap-5 py-6">
          <CardHeader className="px-6">
            <CardTitle className="text-xl font-semibold tracking-tight">
              <h1>{title}</h1>
            </CardTitle>
            {subtitle ? <CardDescription>{subtitle}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-4 px-6">{children}</CardContent>
        </Card>
        {footer
          ? <p className="text-center text-sm text-muted-foreground">
              {footer}
            </p>
          : null}
      </div>
    </main>
  );
}
