fetch('https://alam.egparts.store/').then(r => r.text()).then(t => console.log(t.substring(t.length - 500)))
