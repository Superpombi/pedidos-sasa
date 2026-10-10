# pedidos-sasa

App Pedidos Avon (carpeta `site/`) y el robot que mantiene al dia el catalogo de Avon y Natura.

## Que hace el robot
Todos los dias, GitHub abre las dos revistas, arma el catalogo con las reglas del documento
`metodo-catalogo-avon.md` y corre los controles (C1, C2, C3, C7 y limites de cambios).

- Si pasa los controles, guarda `site/catalogo.json` y `site/catalogo-ciclo-NN.csv`. Netlify publica solo.
- Si falla un control, NO toca nada: la app sigue con el ultimo catalogo bueno, `informes/ultimo.md`
  explica el motivo y GitHub manda un mail de aviso.

## Cuando sale un ciclo nuevo
Editar `config.json`: cambiar `ciclo` y las dos direcciones (`url`) de las revistas.

## Correrlo a mano
En GitHub: pestana **Actions** > **Actualizar catalogo** > **Run workflow**.

## Nota
Este repositorio no guarda contrasenas ni datos personales.
