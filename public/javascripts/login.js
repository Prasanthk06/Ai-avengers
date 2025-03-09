// script.js


// 1. Grab the flip container
const flipContainer = document.getElementById("flip-container");

// 2. Links to flip between forms
const flipToSignup = document.getElementById("flip-to-signup");
const flipToSignin = document.getElementById("flip-to-signin");

// 3. Add event listeners
if (flipToSignup) {
  flipToSignup.addEventListener("click", (e) => {
    e.preventDefault();
    flipContainer.classList.add("flipped");
  });
}

if (flipToSignin) {
  flipToSignin.addEventListener("click", (e) => {
    e.preventDefault();
    flipContainer.classList.remove("flipped");
  });
}

// 4. (Optional) Toggle password visibility
const toggleButtons = document.querySelectorAll(".toggle-visibility");
toggleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "🙈";
    } else {
      input.type = "password";
      btn.textContent = "👁";
    }
  });
});


const loginForm = document.querySelector('.sign-in-form');
const signupForm = document.querySelector('.sign-up-form');


loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log('Login attempt started');
  
  // Show loading or disable the button
  const submitButton = loginForm.querySelector('button[type="submit"]');
  const originalButtonText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Logging in...';
  
  const formData = {
      email: document.getElementById('signin-email').value,
      uniqueCode: document.getElementById('signin-password').value
  };
  console.log('Form data:', formData);
  
  try {
      const response = await fetch('/login', {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData),
          credentials: 'same-origin' // Important for cookies/session
      });
      
      const data = await response.json();
      console.log('Server response:', data);
      
      if (data.success) {
          // Add a message before redirecting
          const loginMessage = document.getElementById('loginMessage');
          loginMessage.textContent = 'Login successful! Redirecting...';
          loginMessage.className = 'message success';
          
          // Delay redirect slightly to show success message
          setTimeout(() => {
              // Use the redirect URL from the response if available
              window.location.href = data.redirectUrl || '/dashboard';
          }, 1000);
      } else {
          // Show error message
          const loginMessage = document.getElementById('loginMessage');
          loginMessage.textContent = data.message || 'Login failed. Please try again.';
          loginMessage.className = 'message error';
          
          // Reset button
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
      }
  } catch (error) {
      console.error('Login error:', error);
      
      // Show error message
      const loginMessage = document.getElementById('loginMessage');
      loginMessage.textContent = 'Connection error. Please try again.';
      loginMessage.className = 'message error';
      
      // Reset button
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
  }
});



signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log('Signup attempt started');
  
  const formData = {
      email: document.getElementById('signup-email').value,
      uniqueCode: document.getElementById('signup-name').value
      // Add other signup fields as needed
  };
  
  try {
      const response = await fetch('/signup', {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
      });
      
      const data = await response.json();
      console.log('Server response:', data);
      
      if (data.success) {
          alert(data.message + ' ' + data.code);
          window.location.href = '/dashboard';
      } else {
          alert(data.message);
      }
  } catch (error) {
      console.error('Signup error:', error);
      alert('Signup failed. Please try again.');
  }
});


document.getElementById('forgotCodeLink').addEventListener('click', () => {
    const email = prompt('Please enter your registered email address:');
    if (email) {
      fetch('/forgot-unique-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      }).then(response => response.json())
        .then(data => {
          alert(data.message);
        }).catch(error => {
          alert('Failed to retrieve unique code. Please try again.');
        });
    }
});

function showMessage(elementId, message, type) {
    const messageElement = document.getElementById(elementId);
    messageElement.textContent = message;
    messageElement.className = `message ${type}`;
    setTimeout(() => {
        messageElement.textContent = '';
    }, 5000);
}