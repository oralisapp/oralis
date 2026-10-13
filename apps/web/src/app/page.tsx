import { redirect } from 'next/navigation';

/**
 * O site público (home, planos, demonstração) é um incremento futuro.
 * Por ora a raiz leva direto à aplicação, que redireciona para o login se preciso.
 */
export default function Home() {
  redirect('/app/visao-geral');
}
