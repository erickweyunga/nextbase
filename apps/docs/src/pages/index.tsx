import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import ThemedImage from "@theme/ThemedImage";
import type { ReactNode } from "react";

export default function Home(): ReactNode {
  return (
    <Layout description="A Postgres database, auth and a REST API that run inside your Next.js app.">
      <main className="container margin-vert--xl text--center">
        <ThemedImage
          alt="NextBase"
          height={72}
          sources={{
            light: "/nextbase-mark-dark.svg",
            dark: "/nextbase-mark-light.svg",
          }}
        />
        <h1 className="hero__title margin-top--lg">
          Your backend, built into Next.js
        </h1>
        <p className="hero__subtitle">
          A Postgres database, authentication and a REST API that run inside
          your app, served at <code>/api/nextbase</code>.
        </p>
        <Link
          className="button button--primary button--lg"
          to="/docs/getting-started"
        >
          Get started
        </Link>
      </main>
    </Layout>
  );
}
