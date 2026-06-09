/* 初回ペイント前にテーマを適用してチラつき（フラッシュ）を防ぐ。
 * CSPでインラインスクリプトが禁止のため外部ファイルにしている。 */
(function () {
  try {
    var t = localStorage.getItem("navyRevenueDeck.theme.v1");
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* localStorage 不可環境では既定（ライト）のまま */
  }
})();
